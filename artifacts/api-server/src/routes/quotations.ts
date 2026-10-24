import { Router } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import { quotationsTable, projectsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { parseQuotationText, parseQuotationImage, parseQuotationPdf, type ParsedQuotation } from "../lib/parse-quotation.js";
import { DeleteQuotationParams, SetBenchmarkParams, UpdateQuotationParams, UpdateQuotationBody } from "@workspace/api-zod";

const router = Router();
// Vercel serverless functions cap request bodies at 4.5MB, so the upload limit
// must stay under that (multipart overhead eats a bit of the margin).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

// Helper: classify the upload and, for non-PDF/image types, extract text
type FileKind = "pdf" | "image" | "text";

async function extractText(buffer: Buffer, mimetype: string, originalname: string): Promise<{ text: string | null; kind: FileKind }> {
  const ext = originalname.split(".").pop()?.toLowerCase() ?? "";

  // Images — handled with vision
  if (mimetype.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
    return { text: null, kind: "image" };
  }

  // PDF — sent to Claude natively (as a document) instead of pre-extracting text,
  // since raw text extraction can scramble table column order in cramped layouts.
  if (mimetype === "application/pdf" || ext === "pdf") {
    return { text: null, kind: "pdf" };
  }

  // Excel
  if (["xlsx", "xls"].includes(ext) || mimetype.includes("spreadsheet") || mimetype.includes("excel")) {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buffer, { type: "buffer" });
    const lines: string[] = [];
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(ws);
      lines.push(`=== Sheet: ${sheetName} ===`);
      lines.push(csv);
    }
    return { text: lines.join("\n"), kind: "text" };
  }

  // DOCX — a zip of XML, not plain text, so it needs real extraction (raw
  // buffer.toString("utf8") on the compressed bytes just produces garbage).
  // Use HTML rather than plain text: some vendor quote tables cram several
  // line items into one table cell as stacked paragraphs instead of separate
  // rows, and flat text extraction loses which paragraph in one column lines
  // up with which paragraph in another — HTML keeps the <table>/<tr>/<td>
  // boundaries so the model can still work out the pairing. Images are
  // stripped (not needed for extraction, and embedding them as base64 can
  // balloon the HTML from a few KB to multiple MB).
  if (ext === "docx" || mimetype.includes("wordprocessingml")) {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.convertToHtml(
      { buffer },
      { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })) },
    );
    return { text: value, kind: "text" };
  }

  // Fallback: plain text
  return { text: buffer.toString("utf8"), kind: "text" };
}

// POST /api/projects/:id/quotations/upload — multipart file upload + AI parse
router.post("/projects/:id/quotations/upload", upload.single("file"), async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  // Check project exists
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // Create quotation record with parsing status
  const [quotation] = await db
    .insert(quotationsTable)
    .values({
      projectId,
      vendorName: "Unknown Vendor",
      fileName: file.originalname,
      fileType: file.mimetype,
      status: "parsing",
      isBenchmark: false,
    })
    .returning();

  // Parse asynchronously but await for response
  try {
    const targetItems = JSON.parse(project.targetItems) as string[];
    const { text, kind } = await extractText(file.buffer, file.mimetype, file.originalname);

    let parsed;
    if (kind === "image") {
      parsed = await parseQuotationImage(file.buffer, file.mimetype, targetItems);
    } else if (kind === "pdf") {
      parsed = await parseQuotationPdf(file.buffer, targetItems);
    } else {
      parsed = await parseQuotationText(text ?? "", targetItems);
    }

    // Some documents genuinely don't state a vendor name (no letterhead), and the
    // model sometimes emits a placeholder string instead of null in that case —
    // normalize both to null so the filename fallback below actually kicks in.
    const isPlaceholder = (value: string | null | undefined) =>
      !value || /^[<[]?\s*(unknown|n\/?a)\s*(vendor)?\s*[>\]]?$/i.test(value.trim());

    parsed.vendorName = isPlaceholder(parsed.vendorName) ? null : parsed.vendorName;
    parsed.vendorAddress = isPlaceholder(parsed.vendorAddress) ? null : parsed.vendorAddress;
    parsed.vendorContact = isPlaceholder(parsed.vendorContact) ? null : parsed.vendorContact;

    const vendorName = parsed.vendorName ?? file.originalname.replace(/\.[^.]+$/, "");

    // Check if this is the first quotation — auto-set as benchmark
    const existingDone = await db
      .select()
      .from(quotationsTable)
      .where(and(eq(quotationsTable.projectId, projectId), eq(quotationsTable.status, "done")));

    const shouldBenchmark = existingDone.length === 0;

    // The benchmark vendor is the reference document — every item it lists should
    // become a proper comparison row, not silently fall into "Other Items" just
    // because the user didn't think to pre-type that category when creating the
    // project. Promote its own unmatched items into new target categories (only
    // for the benchmark; later vendors' unmatched items still land in "Other").
    if (shouldBenchmark) {
      const existingLower = new Map(targetItems.map((t) => [t.toLowerCase(), t]));
      const newCategories: string[] = [];
      for (const item of parsed.items) {
        if (item.matchedCategory !== null) continue;
        const label = item.vendorItemName.trim();
        if (!label) continue;
        const existing = existingLower.get(label.toLowerCase());
        if (existing) {
          // Someone already added this category under slightly different casing —
          // reuse the existing spelling instead of creating a near-duplicate.
          item.matchedCategory = existing;
          continue;
        }
        existingLower.set(label.toLowerCase(), label);
        newCategories.push(label);
        item.matchedCategory = label;
      }
      if (newCategories.length > 0) {
        await db
          .update(projectsTable)
          .set({ targetItems: JSON.stringify([...targetItems, ...newCategories]) })
          .where(eq(projectsTable.id, projectId));
      }
    }

    const [updated] = await db
      .update(quotationsTable)
      .set({
        status: "done",
        vendorName,
        parsedData: JSON.stringify(parsed),
        isBenchmark: shouldBenchmark,
      })
      .where(eq(quotationsTable.id, quotation.id))
      .returning();

    res.status(201).json({
      ...updated,
      createdAt: updated.createdAt.toISOString(),
    });
  } catch (err: unknown) {
    req.log.error(err);
    const message = err instanceof Error ? err.message : "Parsing failed";
    const [updated] = await db
      .update(quotationsTable)
      .set({ status: "error", errorMessage: message })
      .where(eq(quotationsTable.id, quotation.id))
      .returning();
    res.status(201).json({
      ...updated,
      createdAt: updated.createdAt.toISOString(),
    });
  }
});

// GET /api/projects/:id/quotations
router.get("/projects/:id/quotations", async (req, res) => {
  const projectId = Number(req.params.id);
  if (isNaN(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  try {
    const quotations = await db
      .select()
      .from(quotationsTable)
      .where(eq(quotationsTable.projectId, projectId))
      .orderBy(quotationsTable.createdAt);
    res.json(quotations.map((q) => ({ ...q, createdAt: q.createdAt.toISOString() })));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/projects/:id/quotations/:qid — edit extracted data (grid editor)
router.patch("/projects/:id/quotations/:qid", async (req, res) => {
  const parsedParams = UpdateQuotationParams.safeParse({
    id: Number(req.params.id),
    qid: Number(req.params.qid),
  });
  const parsedBody = UpdateQuotationBody.safeParse(req.body);
  if (!parsedParams.success || !parsedBody.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  try {
    const [existing] = await db
      .select()
      .from(quotationsTable)
      .where(and(eq(quotationsTable.id, parsedParams.data.qid), eq(quotationsTable.projectId, parsedParams.data.id)));
    if (!existing) {
      res.status(404).json({ error: "Quotation not found" });
      return;
    }

    const blankInfo = {
      designingCharges: null, gst: null, installation: null, freight: null,
      leadTime: null, samplesForReview: null, paymentSchedule: null, warranty: null,
    };
    const current: ParsedQuotation = existing.parsedData
      ? (JSON.parse(existing.parsedData) as ParsedQuotation)
      : { vendorName: null, vendorAddress: null, vendorContact: null, items: [], additionalInfo: blankInfo, grandTotal: null };

    const body = parsedBody.data;

    const updatedParsed: ParsedQuotation = {
      vendorName: body.vendorName !== undefined ? body.vendorName : current.vendorName,
      vendorAddress: body.vendorAddress !== undefined ? body.vendorAddress : current.vendorAddress,
      vendorContact: body.vendorContact !== undefined ? body.vendorContact : current.vendorContact,
      items: body.items
        ? body.items.map((item) => ({
            matchedCategory: item.matchedCategory ?? null,
            vendorItemName: item.vendorItemName,
            spec: item.spec ?? null,
            quantity: item.quantity,
            mrp: item.mrp ?? null,
            unitPrice: item.unitPrice,
            discountPercent: item.discountPercent ?? null,
            totalPrice: item.totalPrice,
            gstPercent: item.gstPercent ?? null,
            freight: item.freight ?? null,
            otherCharges: item.otherCharges ?? null,
            ...(item.format ? { format: item.format } : {}),
            ...(item.customFields ? { customFields: item.customFields } : {}),
          }))
        : current.items,
      additionalInfo: body.additionalInfo
        ? {
            designingCharges: body.additionalInfo.designingCharges !== undefined ? body.additionalInfo.designingCharges : current.additionalInfo.designingCharges,
            gst: body.additionalInfo.gst !== undefined ? body.additionalInfo.gst : current.additionalInfo.gst,
            installation: body.additionalInfo.installation !== undefined ? body.additionalInfo.installation : current.additionalInfo.installation,
            freight: body.additionalInfo.freight !== undefined ? body.additionalInfo.freight : current.additionalInfo.freight,
            leadTime: body.additionalInfo.leadTime !== undefined ? body.additionalInfo.leadTime : current.additionalInfo.leadTime,
            samplesForReview: body.additionalInfo.samplesForReview !== undefined ? body.additionalInfo.samplesForReview : current.additionalInfo.samplesForReview,
            paymentSchedule: body.additionalInfo.paymentSchedule !== undefined ? body.additionalInfo.paymentSchedule : current.additionalInfo.paymentSchedule,
            warranty: body.additionalInfo.warranty !== undefined ? body.additionalInfo.warranty : current.additionalInfo.warranty,
          }
        : current.additionalInfo,
      grandTotal: body.grandTotal !== undefined ? body.grandTotal : current.grandTotal,
    };

    // Keep the display vendorName column (used in lists/exports) in sync with the edit.
    const displayVendorName = updatedParsed.vendorName || existing.vendorName;

    const [updated] = await db
      .update(quotationsTable)
      .set({ parsedData: JSON.stringify(updatedParsed), vendorName: displayVendorName })
      .where(eq(quotationsTable.id, parsedParams.data.qid))
      .returning();

    res.json({ ...updated, createdAt: updated.createdAt.toISOString() });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/projects/:id/quotations/:qid
router.delete("/projects/:id/quotations/:qid", async (req, res) => {
  const parsed = DeleteQuotationParams.safeParse({
    id: Number(req.params.id),
    qid: Number(req.params.qid),
  });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }
  try {
    await db
      .delete(quotationsTable)
      .where(
        and(
          eq(quotationsTable.id, parsed.data.qid),
          eq(quotationsTable.projectId, parsed.data.id)
        )
      );
    res.status(204).send();
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/projects/:id/quotations/:qid/set-benchmark
router.post("/projects/:id/quotations/:qid/set-benchmark", async (req, res) => {
  const parsed = SetBenchmarkParams.safeParse({
    id: Number(req.params.id),
    qid: Number(req.params.qid),
  });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }
  try {
    // Clear existing benchmark for this project
    await db
      .update(quotationsTable)
      .set({ isBenchmark: false })
      .where(eq(quotationsTable.projectId, parsed.data.id));

    // Set new benchmark
    await db
      .update(quotationsTable)
      .set({ isBenchmark: true })
      .where(
        and(
          eq(quotationsTable.id, parsed.data.qid),
          eq(quotationsTable.projectId, parsed.data.id)
        )
      );

    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, parsed.data.id));
    const quotationCount = await db
      .select()
      .from(quotationsTable)
      .where(eq(quotationsTable.projectId, parsed.data.id));

    res.json({
      ...project,
      targetItems: JSON.parse(project.targetItems) as string[],
      createdAt: project.createdAt.toISOString(),
      quotationCount: quotationCount.length,
      benchmarkQuotationId: parsed.data.qid,
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
