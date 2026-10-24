import { Router } from "express";
import { db } from "@workspace/db";
import { quotationsTable, projectsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { buildComparison, type VendorLineItem, type OtherItem } from "../lib/build-comparison.js";
import type { ParsedQuotation, ItemFormat, ItemFormatMap } from "../lib/parse-quotation.js";
import { computeCharges, CHARGE_LABELS, type ChargeBreakdown } from "../lib/charges.js";
import ExcelJS from "exceljs";

const router = Router();

// GET /api/projects/:id/comparison
router.get("/projects/:id/comparison", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, id));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const quotations = await db
      .select()
      .from(quotationsTable)
      .where(eq(quotationsTable.projectId, id))
      .orderBy(quotationsTable.createdAt);

    const targetItems = JSON.parse(project.targetItems) as string[];
    const result = buildComparison(id, quotations, targetItems);
    res.json({
      ...result,
      vendors: result.vendors.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/projects/:id/summary
router.get("/projects/:id/summary", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, id));
    const quotations = await db
      .select()
      .from(quotationsTable)
      .where(eq(quotationsTable.projectId, id));

    const done = quotations.filter((q) => q.status === "done" && q.parsedData);
    const pending = quotations.filter((q) => q.status !== "done");

    // Calculate totals from parsed data
    const totals = done
      .map((q) => {
        try {
          const parsed = JSON.parse(q.parsedData!) as ParsedQuotation;
          // Rank vendors on our own calculation (items + charges + GST), not the total
          // printed on their document, which may contain arithmetic mistakes.
          const total = parsed.items.length > 0
            ? computeCharges(parsed.items, parsed.additionalInfo).grandTotal
            : parsed.grandTotal;
          return { vendorName: q.vendorName, total };
        } catch {
          return { vendorName: q.vendorName, total: null };
        }
      })
      .filter((t): t is { vendorName: string; total: number } => t.total !== null);

    const validTotals = totals.map((t) => t.total);
    const lowestTotal = validTotals.length ? Math.min(...validTotals) : null;
    const highestTotal = validTotals.length ? Math.max(...validTotals) : null;
    const lowestVendor = lowestTotal !== null ? totals.find((t) => t.total === lowestTotal)?.vendorName ?? null : null;
    const highestVendor = highestTotal !== null ? totals.find((t) => t.total === highestTotal)?.vendorName ?? null : null;

    const itemCount = project ? (JSON.parse(project.targetItems) as string[]).length : 0;

    res.json({
      projectId: id,
      vendorCount: quotations.length,
      itemCount,
      hasBenchmark: quotations.some((q) => q.isBenchmark),
      lowestTotal,
      highestTotal,
      lowestVendor,
      highestVendor,
      parsedCount: done.length,
      pendingCount: pending.length,
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/projects/:id/export — download comparison as Excel
router.get("/projects/:id/export", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, id));
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }

    const quotations = await db
      .select().from(quotationsTable)
      .where(eq(quotationsTable.projectId, id))
      .orderBy(quotationsTable.createdAt);

    const targetItems = JSON.parse(project.targetItems) as string[];
    const result = buildComparison(id, quotations, targetItems);

    const customColumns = JSON.parse(project.customColumns) as { id: string; label: string }[];
    const columnLabels = JSON.parse(project.columnLabels) as Partial<Record<
      "spec" | "qty" | "mrp" | "unitPrice" | "discountPercent" | "totalPrice",
      string
    >>;
    const defaultLabels = { spec: "Spec", qty: "Qty", mrp: "MRP", unitPrice: "Unit Price", discountPercent: "Disc %", totalPrice: "Total Amount" };
    const subHeaderLabels = [
      columnLabels.spec || defaultLabels.spec,
      columnLabels.qty || defaultLabels.qty,
      columnLabels.mrp || defaultLabels.mrp,
      columnLabels.unitPrice || defaultLabels.unitPrice,
      columnLabels.discountPercent || defaultLabels.discountPercent,
      columnLabels.totalPrice || defaultLabels.totalPrice,
      ...customColumns.map((c) => c.label),
    ];

    // Parse exclusion params from query string
    const excludeVendorIds = new Set(
      ((req.query.excludeVendors as string) || "")
        .split(",").filter(Boolean).map(Number)
    );
    const excludeRowKeys = new Set(
      ((req.query.excludeRows as string) || "")
        .split(";;").filter(Boolean)
    );

    const doneVendors = result.vendors
      .filter((v) => v.status === "done" && !excludeVendorIds.has(v.id));
    const filteredRows = excludeRowKeys.size
      ? result.rows.filter((r) => !excludeRowKeys.has(r.category))
      : result.rows;

    result.rows = filteredRows;

    const nv = doneVendors.length;

    // ── Column layout ────────────────────────────────────────────────
    // Col 1: Category (A)
    // Per vendor: Spec | Qty | MRP | Unit Price | Disc % | Total | [custom columns...] | [gap]
    const CAT_COL = 1;
    const NUM_DATA_COLS = 6 + customColumns.length;
    const VENDOR_STRIDE = NUM_DATA_COLS + 1;
    const vendorStartCol = (vi: number) => 2 + vi * VENDOR_STRIDE; // 1-based Spec col
    const specCol  = (vi: number) => vendorStartCol(vi);
    const qtyCol   = (vi: number) => vendorStartCol(vi) + 1;
    const mrpCol   = (vi: number) => vendorStartCol(vi) + 2;
    const unitCol  = (vi: number) => vendorStartCol(vi) + 3;
    const discCol  = (vi: number) => vendorStartCol(vi) + 4;
    const totalCol = (vi: number) => vendorStartCol(vi) + 5;
    const customCol = (vi: number, ci: number) => vendorStartCol(vi) + 6 + ci;

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Comparison");

    // ── Styles ───────────────────────────────────────────────────────
    const DARK_BLUE   = "FF1F4E79";
    const MID_BLUE    = "FF2E75B6";
    const GREEN_FILL  = "FFE2EFDA";
    const GRAY_FILL   = "FFF2F2F2";
    const HIGHLIGHT_FILL = "FFFFF59D";
    const WHITE       = "FFFFFFFF";

    const boldWhite  = { bold: true, color: { argb: WHITE } };
    const boldBlack  = { bold: true };
    const thinBorder = { style: "thin" as const, color: { argb: "FFB0B0B0" } };
    const allBorders = { top: thinBorder, left: thinBorder, bottom: thinBorder, right: thinBorder };

    // Applies bold/italic/underline/highlight for a single cell from a line item's saved
    // per-column format, on top of whatever font/fill styling the cell already has.
    const applyItemFormat = (cell: ExcelJS.Cell, format: ItemFormat | undefined) => {
      if (!format) return;
      if (format.bold || format.italic || format.underline) {
        const existing = (cell.font ?? {}) as ExcelJS.Font;
        cell.font = {
          ...existing,
          bold: format.bold || existing.bold,
          italic: format.italic || existing.italic,
          underline: format.underline || existing.underline,
        };
      }
      if (format.highlight) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HIGHLIGHT_FILL } };
      }
    };

    // Applies each of the 6 standard cells' own format from the item's per-column map —
    // e.g. bolding just the Total cell no longer bolds Qty/Rate/etc on the same row.
    const applyRowFormat = (
      cells: { sCell: ExcelJS.Cell; qCell: ExcelJS.Cell; mCell: ExcelJS.Cell; uCell: ExcelJS.Cell; dCell: ExcelJS.Cell; tCell: ExcelJS.Cell },
      formatMap: ItemFormatMap | undefined,
      nameFormat?: ItemFormat,
    ) => {
      if (!formatMap && !nameFormat) return;
      // The Spec column also displays the item name (they share one Excel cell), so merge both.
      applyItemFormat(cells.sCell, nameFormat);
      applyItemFormat(cells.sCell, formatMap?.spec);
      applyItemFormat(cells.qCell, formatMap?.quantity);
      applyItemFormat(cells.mCell, formatMap?.mrp);
      applyItemFormat(cells.uCell, formatMap?.unitPrice);
      applyItemFormat(cells.dCell, formatMap?.discountPercent);
      applyItemFormat(cells.tCell, formatMap?.totalPrice);
    };

    // ── Row 1: Vendor names ──────────────────────────────────────────
    const nameRow = ws.addRow([]);
    nameRow.height = 42;
    nameRow.getCell(CAT_COL).value = "";

    doneVendors.forEach((vendor, vi) => {
      const detail = result.vendorDetails?.find((d) => d.quotationId === vendor.id);
      const sc = vendorStartCol(vi);
      const lines = [vendor.vendorName];
      if (detail?.vendorAddress) lines.push(detail.vendorAddress);
      if (detail?.vendorContact) lines.push(detail.vendorContact);

      const cell = nameRow.getCell(sc);
      cell.value = lines.join("\n");
      cell.font  = boldWhite;
      cell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: DARK_BLUE } };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.border = allBorders;

      // Merge across the vendor's data cols (not the gap)
      ws.mergeCells(1, sc, 1, sc + NUM_DATA_COLS - 1);
    });

    // ── Row 2: Sub-headers ───────────────────────────────────────────
    const subRow = ws.addRow([]);
    subRow.height = 20;

    doneVendors.forEach((_v, vi) => {
      const sc = vendorStartCol(vi);
      subHeaderLabels.forEach((lbl, offset) => {
        const cell = subRow.getCell(sc + offset);
        cell.value = lbl;
        cell.font  = { bold: true, color: { argb: WHITE }, size: 9 };
        cell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: MID_BLUE } };
        cell.alignment = { horizontal: offset === 0 ? "left" : "right", vertical: "middle" };
        cell.border = allBorders;
      });
    });

    const writeCustomFields = (row: ExcelJS.Row, vi: number, customFields: Record<string, string> | undefined, formatMap: ItemFormatMap | undefined) => {
      customColumns.forEach((col, ci) => {
        const cell = row.getCell(customCol(vi, ci));
        cell.value = customFields?.[col.id] ?? "";
        cell.alignment = { horizontal: "right", vertical: "middle" };
        cell.border = allBorders;
        applyItemFormat(cell, formatMap?.[col.id]);
      });
    };

    // ── Item rows, one per category ────────────────────────────────────
    for (const row of result.rows) {
      const excelRow = ws.addRow([]);
      excelRow.height = 16;

      const catCell = excelRow.getCell(CAT_COL);
      catCell.value = row.category;
      catCell.font  = boldBlack;
      catCell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: GRAY_FILL } };
      catCell.border = allBorders;

      // Find lowest total for green highlight
      const prices = row.vendors
        .filter((v) => v.available && v.totalPrice != null)
        .map((v) => v.totalPrice!);
      const minPrice = prices.length ? Math.min(...prices) : null;

      doneVendors.forEach((vendor, vi) => {
        const vr  = row.vendors.find((v) => v.quotationId === vendor.id);
        const sc  = vendorStartCol(vi);
        const isLowest = vr?.available && vr.totalPrice != null && vr.totalPrice === minPrice;
        // Format only carries over unambiguously when exactly one line item makes up this row.
        const soleItem: VendorLineItem | undefined = vr?.lineItems.length === 1 ? vr.lineItems[0] : undefined;

        const sCell = excelRow.getCell(sc);
        const qCell = excelRow.getCell(sc + 1);
        const mCell = excelRow.getCell(sc + 2);
        const uCell = excelRow.getCell(sc + 3);
        const dCell = excelRow.getCell(sc + 4);
        const tCell = excelRow.getCell(sc + 5);

        if (vr?.available) {
          sCell.value = vr.vendorItemName
            ? `${vr.vendorItemName}${vr.spec ? " — " + vr.spec : ""}`
            : (vr.spec ?? "");
          qCell.value = vr.quantity ?? "";
          mCell.value = vr.mrp ?? "";
          uCell.value = vr.unitPrice ?? "";
          dCell.value = vr.discountPercent != null ? `${vr.discountPercent}%` : "";
          tCell.value = vr.totalPrice ?? "";
        }

        sCell.alignment = { horizontal: "left", vertical: "middle" };
        sCell.border = allBorders;
        [qCell, mCell, uCell, dCell, tCell].forEach((c) => {
          c.alignment = { horizontal: "right", vertical: "middle" };
          c.border = allBorders;
          if (typeof c.value === "number" && (c === mCell || c === uCell || c === tCell)) {
            c.numFmt = '₹#,##0';
          }
        });

        if (isLowest) {
          tCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN_FILL } };
          tCell.font = { bold: true, color: { argb: "FF375623" } };
        }

        if (soleItem) {
          applyRowFormat({ sCell, qCell, mCell, uCell, dCell, tCell }, soleItem.format);
        }
        writeCustomFields(excelRow, vi, soleItem?.customFields, soleItem?.format);
      });

      // If any vendor quoted multiple size/variant line items under this category
      // (e.g. several nameplate sizes), add breakdown rows beneath the aggregate row.
      const maxVariants = Math.max(0, ...row.vendors.map((v) => v.lineItems.length));
      if (maxVariants > 1) {
        for (let li = 0; li < maxVariants; li++) {
          const variantRow = ws.addRow([]);
          variantRow.height = 14;
          const lblCell = variantRow.getCell(CAT_COL);
          lblCell.value = "";
          lblCell.border = allBorders;

          doneVendors.forEach((vendor, vi) => {
            const vr = row.vendors.find((v) => v.quotationId === vendor.id);
            const item = vr?.lineItems[li];
            const sc = vendorStartCol(vi);
            const sCell = variantRow.getCell(sc);
            const qCell = variantRow.getCell(sc + 1);
            const mCell = variantRow.getCell(sc + 2);
            const uCell = variantRow.getCell(sc + 3);
            const dCell = variantRow.getCell(sc + 4);
            const tCell = variantRow.getCell(sc + 5);

            if (item) {
              sCell.value = `${item.vendorItemName}${item.spec ? " — " + item.spec : ""}`;
              qCell.value = item.quantity;
              mCell.value = item.mrp ?? "";
              uCell.value = item.unitPrice;
              dCell.value = item.discountPercent != null ? `${item.discountPercent}%` : "";
              tCell.value = item.totalPrice;
            }

            [sCell, qCell, mCell, uCell, dCell, tCell].forEach((c) => {
              c.font = { italic: true, size: 8, color: { argb: "FF666666" } };
              c.border = allBorders;
              if (typeof c.value === "number" && (c === mCell || c === uCell || c === tCell)) {
                c.numFmt = '₹#,##0';
              }
            });
            sCell.alignment = { horizontal: "left", vertical: "middle" };
            [qCell, mCell, uCell, dCell, tCell].forEach((c) => {
              c.alignment = { horizontal: "right", vertical: "middle" };
            });

            if (item) {
              applyRowFormat({ sCell, qCell, mCell, uCell, dCell, tCell }, item.format, item.format?.vendorItemName);
            }
            writeCustomFields(variantRow, vi, item?.customFields, item?.format);
          });
        }
      }
    }

    // ── Other items offered — same table, same per-vendor column layout ──
    const otherByVendor = new Map<number, OtherItem[]>();
    for (const vendor of doneVendors) {
      otherByVendor.set(vendor.id, result.otherItems.filter((item) => item.quotationId === vendor.id));
    }
    const maxOther = Math.max(0, ...doneVendors.map((v) => (otherByVendor.get(v.id) ?? []).length));

    if (maxOther > 0) {
      ws.addRow([]).height = 4;
      const headerRow = ws.addRow([]);
      headerRow.height = 18;
      const headerCell = headerRow.getCell(CAT_COL);
      headerCell.value = "Other Items Offered";
      headerCell.font = { bold: true, italic: true };
      headerCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GRAY_FILL } };
      headerCell.border = allBorders;
      doneVendors.forEach((_v, vi) => {
        const sc = vendorStartCol(vi);
        for (let off = 0; off < NUM_DATA_COLS; off++) headerRow.getCell(sc + off).border = allBorders;
      });

      for (let oi = 0; oi < maxOther; oi++) {
        const itemRow = ws.addRow([]);
        itemRow.height = 14;
        itemRow.getCell(CAT_COL).border = allBorders;

        doneVendors.forEach((vendor, vi) => {
          const item = (otherByVendor.get(vendor.id) ?? [])[oi];
          const sc = vendorStartCol(vi);
          const sCell = itemRow.getCell(sc);
          const qCell = itemRow.getCell(sc + 1);
          const mCell = itemRow.getCell(sc + 2);
          const uCell = itemRow.getCell(sc + 3);
          const dCell = itemRow.getCell(sc + 4);
          const tCell = itemRow.getCell(sc + 5);

          if (item) {
            sCell.value = `${item.vendorItemName}${item.spec ? " — " + item.spec : ""}`;
            qCell.value = item.quantity;
            mCell.value = item.mrp ?? "";
            uCell.value = item.unitPrice;
            dCell.value = item.discountPercent != null ? `${item.discountPercent}%` : "";
            tCell.value = item.totalPrice;
          }

          [sCell, qCell, mCell, uCell, dCell, tCell].forEach((c) => {
            c.font = { italic: true, size: 8, color: { argb: "FF666666" } };
            c.border = allBorders;
            if (typeof c.value === "number" && (c === mCell || c === uCell || c === tCell)) {
              c.numFmt = '₹#,##0';
            }
          });
          sCell.alignment = { horizontal: "left", vertical: "middle" };
          [qCell, mCell, uCell, dCell, tCell].forEach((c) => {
            c.alignment = { horizontal: "right", vertical: "middle" };
          });

          if (item) {
            applyRowFormat({ sCell, qCell, mCell, uCell, dCell, tCell }, item.format, item.format?.vendorItemName);
          }
          writeCustomFields(itemRow, vi, item?.customFields, item?.format);
        });
      }
    }

    // ── Terms rows (lead time, samples, payment, warranty) ───────────
    // The monetary ones (designing, freight, installation, GST) are not listed here as
    // free text — they're calculated and shown as rows in the totals block below.
    ws.addRow([]).height = 8;

    const CHARGE_LABEL_SET = new Set<string>(Object.values(CHARGE_LABELS));
    for (const info of result.additionalInfo.filter((i) => !CHARGE_LABEL_SET.has(i.label))) {
      const infoRow = ws.addRow([]);
      infoRow.height = 16;

      const labelCell = infoRow.getCell(CAT_COL);
      labelCell.value = info.label;
      labelCell.font  = { italic: true, bold: true };
      labelCell.border = allBorders;

      doneVendors.forEach((_v, vi) => {
        const val = info.vendors.find((v) => v.quotationId === _v.id)?.value ?? "-";
        const sc = vendorStartCol(vi);

        // Merge the value across all of the vendor's data cols
        const cell = infoRow.getCell(sc);
        cell.value = val;
        cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
        cell.border = allBorders;
        ws.mergeCells(infoRow.number, sc, infoRow.number, sc + NUM_DATA_COLS - 1);
      });
    }

    // ── Charges & totals ─────────────────────────────────────────────
    // Calculated by us from each vendor's line items and quoted charge text rather than
    // copied from the vendor's own grand total, since vendors make arithmetic mistakes.
    const MONEY_FMT = '₹#,##0.00';
    const AMBER_FILL = "FFFFE699";
    const stated = new Map<number, ParsedQuotation>();
    const breakdowns = new Map<number, ChargeBreakdown>();
    for (const v of doneVendors) {
      if (!v.parsedData) continue;
      const parsed = JSON.parse(v.parsedData) as ParsedQuotation;
      stated.set(v.id, parsed);
      breakdowns.set(v.id, computeCharges(parsed.items, parsed.additionalInfo));
    }
    const rupees = (n: number) => "₹" + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n);

    ws.addRow([]).height = 8;

    // One row: label in col A, descriptive text across Spec..Disc, amount under the Total column.
    const addAmountRow = (
      label: string,
      cellsFor: (b: ChargeBreakdown) => { text: string; amount: number | null },
      style: { bold?: boolean; fill?: string; fontColor?: string; height?: number } = {},
    ) => {
      const row = ws.addRow([]);
      row.height = style.height ?? 16;
      const lc = row.getCell(CAT_COL);
      lc.value = label;
      lc.font = { bold: true, italic: !style.bold, color: style.fontColor ? { argb: style.fontColor } : undefined };
      if (style.fill) lc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: style.fill } };
      lc.border = allBorders;

      let longestText = 0;
      doneVendors.forEach((v, vi) => {
        const b = breakdowns.get(v.id);
        const sc = vendorStartCol(vi);
        for (let off = 0; off < NUM_DATA_COLS; off++) {
          const c = row.getCell(sc + off);
          c.border = allBorders;
          if (style.fill) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: style.fill } };
        }
        if (!b) return;
        const { text, amount } = cellsFor(b);
        longestText = Math.max(longestText, text.length);
        const tc = row.getCell(sc);
        tc.value = text;
        tc.font = { size: 9, italic: true, color: { argb: style.fontColor ?? "FF666666" } };
        tc.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
        ws.mergeCells(row.number, sc, row.number, sc + 4);

        const ac = row.getCell(totalCol(vi));
        ac.value = amount ?? "-";
        ac.numFmt = MONEY_FMT;
        ac.font = { bold: !!style.bold, color: style.fontColor ? { argb: style.fontColor } : undefined };
        ac.alignment = { horizontal: "right", vertical: "middle" };
      });
      // The text cell spans roughly 55 characters at this font size — grow the row to fit.
      row.height = Math.max(row.height ?? 16, Math.ceil(longestText / 55) * 12 + 4);
      return row;
    };

    addAmountRow("Items Subtotal", (b) => ({ text: "", amount: b.itemsSubtotal }), { bold: true });

    for (const key of ["designingCharges", "freight", "installation"] as const) {
      addAmountRow(CHARGE_LABELS[key], (b) => {
        const line = b.lines.find((l) => l.key === key)!;
        if (line.itemisedAmount > 0) return { text: `Already listed as an item above (${rupees(line.itemisedAmount)})`, amount: null };
        if (line.waived) return { text: `${line.basis} — no charge`, amount: 0 };
        if (!line.basis) return { text: "Not stated", amount: null };
        return { text: line.basis, amount: line.amount };
      });
    }

    addAmountRow("Total before GST", (b) => ({ text: "", amount: b.taxableValue }), { bold: true, fill: GRAY_FILL });

    addAmountRow("GST", (b) => {
      if (b.gst.included) return { text: `${b.gst.basis} — already included in the prices above, nothing added`, amount: 0 };
      if (b.gst.rate != null) return { text: `${b.gst.rate}% of ${rupees(b.taxableValue)} (calculated)`, amount: b.gst.amount };
      if (b.gst.basis) return { text: `${b.gst.basis} — amount as stated by vendor, rate unknown`, amount: b.gst.amount };
      return { text: "GST not stated — NOT included in the total below", amount: null };
    }, { bold: true });

    ws.addRow([]).height = 6;

    // Grand total
    const gtRow = ws.addRow([]);
    gtRow.height = 22;

    const gtLabel = gtRow.getCell(CAT_COL);
    gtLabel.value = "GRAND TOTAL (incl. GST)";
    gtLabel.font  = { bold: true, size: 11, color: { argb: WHITE } };
    gtLabel.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: DARK_BLUE } };
    gtLabel.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    gtLabel.border = allBorders;

    doneVendors.forEach((_v, vi) => {
      const sc = vendorStartCol(vi);
      const cell = gtRow.getCell(sc);
      cell.value = breakdowns.get(_v.id)?.grandTotal ?? "";
      cell.numFmt = MONEY_FMT;
      cell.font  = { bold: true, size: 11, color: { argb: WHITE } };
      cell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: DARK_BLUE } };
      cell.alignment = { horizontal: "right", vertical: "middle" };
      cell.border = allBorders;
      ws.mergeCells(gtRow.number, sc, gtRow.number, sc + NUM_DATA_COLS - 1);
    });

    // Cross-check against the total the vendor printed on their own document
    const checkRow = ws.addRow([]);
    checkRow.height = 28;
    const checkLabel = checkRow.getCell(CAT_COL);
    checkLabel.value = "Check vs vendor's quote";
    checkLabel.font = { italic: true, bold: true };
    checkLabel.border = allBorders;

    doneVendors.forEach((_v, vi) => {
      const sc = vendorStartCol(vi);
      const calc = breakdowns.get(_v.id)?.grandTotal;
      const vendorTotal = stated.get(_v.id)?.grandTotal ?? null;
      const cell = checkRow.getCell(sc);
      cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
      cell.border = allBorders;
      cell.font = { size: 9 };
      if (calc == null || vendorTotal == null) {
        cell.value = "Vendor's own total not available to compare";
      } else if (Math.abs(calc - vendorTotal) < 1) {
        cell.value = `✓ Matches the vendor's quoted total (${rupees(vendorTotal)})`;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN_FILL } };
      } else {
        const diff = calc - vendorTotal;
        cell.value = `⚠ Vendor quoted ${rupees(vendorTotal)} — our calculation is ${rupees(Math.abs(diff))} ${diff < 0 ? "lower" : "higher"}`;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AMBER_FILL } };
      }
      ws.mergeCells(checkRow.number, sc, checkRow.number, sc + NUM_DATA_COLS - 1);
    });

    // ── Column widths ────────────────────────────────────────────────
    ws.getColumn(CAT_COL).width = 20;
    for (let vi = 0; vi < nv; vi++) {
      ws.getColumn(specCol(vi)).width = 14;
      ws.getColumn(qtyCol(vi)).width = 7;
      ws.getColumn(mrpCol(vi)).width = 12;
      ws.getColumn(unitCol(vi)).width = 14;
      ws.getColumn(discCol(vi)).width = 9;
      ws.getColumn(totalCol(vi)).width = 14;
      customColumns.forEach((_c, ci) => { ws.getColumn(customCol(vi, ci)).width = 12; });
      ws.getColumn(vendorStartCol(vi) + NUM_DATA_COLS).width = 2; // gap
    }

    // Freeze top 2 rows + col A
    ws.views = [{ state: "frozen", xSplit: 1, ySplit: 2, topLeftCell: "B3", activeCell: "B3" }];

    const filename = `${project.name.replace(/[^a-z0-9]/gi, "_")}_comparison.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
