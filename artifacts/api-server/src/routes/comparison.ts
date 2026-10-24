import { Router } from "express";
import { db } from "@workspace/db";
import { quotationsTable, projectsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { buildComparison, type VendorLineItem, type OtherItem } from "../lib/build-comparison.js";
import type { ParsedQuotation, ItemFormat, ItemFormatMap } from "../lib/parse-quotation.js";
import { resolveItems, resolveVendorInComparison, CHARGE_LABELS, TOTAL_TOLERANCE, type ResolvedItem, type VendorComparisonResolution } from "../lib/charges.js";
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
            ? resolveItems(parsed.items, parsed.additionalInfo).grandTotal
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
      "spec" | "qty" | "mrp" | "unitPrice" | "discountPercent" | "gstPercent" | "freight" | "otherCharges" | "totalPrice",
      string
    >>;
    const defaultLabels = {
      spec: "Spec", qty: "Qty", mrp: "MRP", unitPrice: "Unit Price", discountPercent: "Disc %",
      gstPercent: "GST %", freight: "Freight", otherCharges: "Other Charges", totalPrice: "Total (incl. GST)",
    };
    const subHeaderLabels = [
      columnLabels.spec || defaultLabels.spec,
      columnLabels.qty || defaultLabels.qty,
      columnLabels.mrp || defaultLabels.mrp,
      columnLabels.unitPrice || defaultLabels.unitPrice,
      columnLabels.discountPercent || defaultLabels.discountPercent,
      columnLabels.gstPercent || defaultLabels.gstPercent,
      columnLabels.freight || defaultLabels.freight,
      columnLabels.otherCharges || defaultLabels.otherCharges,
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

    // Our own calculation of every row's GST, freight, other charges and total (a value the user
    // typed on a row wins; otherwise it defaults from what the vendor quoted). Resolved on the full
    // row list, before any rows are excluded, because the results are indexed by row position.
    const resolutions = new Map<number, VendorComparisonResolution>();
    for (const v of doneVendors) resolutions.set(v.id, resolveVendorInComparison(result, v.id));
    const rowIndexByCategory = new Map(result.rows.map((r, i) => [r.category, i]));

    const filteredRows = excludeRowKeys.size
      ? result.rows.filter((r) => !excludeRowKeys.has(r.category))
      : result.rows;

    result.rows = filteredRows;

    const nv = doneVendors.length;

    // ── Column layout ────────────────────────────────────────────────
    // Col 1: Category (A)
    // Per vendor: Spec | Qty | MRP | Unit Price | Disc % | GST % | Freight | Other | Total | [custom columns...] | [gap]
    const CAT_COL = 1;
    const NUM_DATA_COLS = 9 + customColumns.length;
    const VENDOR_STRIDE = NUM_DATA_COLS + 1;
    const vendorStartCol = (vi: number) => 2 + vi * VENDOR_STRIDE; // 1-based Spec col
    const specCol    = (vi: number) => vendorStartCol(vi);
    const qtyCol     = (vi: number) => vendorStartCol(vi) + 1;
    const mrpCol     = (vi: number) => vendorStartCol(vi) + 2;
    const unitCol    = (vi: number) => vendorStartCol(vi) + 3;
    const discCol    = (vi: number) => vendorStartCol(vi) + 4;
    const gstCol     = (vi: number) => vendorStartCol(vi) + 5;
    const freightCol = (vi: number) => vendorStartCol(vi) + 6;
    const otherCol   = (vi: number) => vendorStartCol(vi) + 7;
    const totalCol   = (vi: number) => vendorStartCol(vi) + 8;
    const customCol  = (vi: number, ci: number) => vendorStartCol(vi) + 9 + ci;

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Comparison");

    // ── Styles ───────────────────────────────────────────────────────
    const DARK_BLUE   = "FF1F4E79";
    const MID_BLUE    = "FF2E75B6";
    const GREEN_FILL  = "FFE2EFDA";
    const GRAY_FILL   = "FFF2F2F2";
    const AMBER_FILL  = "FFFFE699";
    const HIGHLIGHT_FILL = "FFFFF59D";
    const WHITE       = "FFFFFFFF";
    const MONEY_FMT   = '₹#,##0.00';

    const boldWhite  = { bold: true, color: { argb: WHITE } };
    const boldBlack  = { bold: true };
    const thinBorder = { style: "thin" as const, color: { argb: "FFB0B0B0" } };
    const allBorders = { top: thinBorder, left: thinBorder, bottom: thinBorder, right: thinBorder };

    const rupees = (n: number) => "₹" + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n);

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

    type RowCells = {
      sCell: ExcelJS.Cell; qCell: ExcelJS.Cell; mCell: ExcelJS.Cell; uCell: ExcelJS.Cell; dCell: ExcelJS.Cell
      gCell: ExcelJS.Cell; fCell: ExcelJS.Cell; oCell: ExcelJS.Cell; tCell: ExcelJS.Cell
    };

    // Gets the standard cells of a row for one vendor.
    const cellsFor = (row: ExcelJS.Row, vi: number): RowCells => ({
      sCell: row.getCell(specCol(vi)),
      qCell: row.getCell(qtyCol(vi)),
      mCell: row.getCell(mrpCol(vi)),
      uCell: row.getCell(unitCol(vi)),
      dCell: row.getCell(discCol(vi)),
      gCell: row.getCell(gstCol(vi)),
      fCell: row.getCell(freightCol(vi)),
      oCell: row.getCell(otherCol(vi)),
      tCell: row.getCell(totalCol(vi)),
    });

    // Applies each standard cell's own format from the item's per-column map —
    // e.g. bolding just the Total cell no longer bolds Qty/Rate/etc on the same row.
    const applyRowFormat = (cells: RowCells, formatMap: ItemFormatMap | undefined, nameFormat?: ItemFormat) => {
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

    // Number formats and alignment shared by every item-like row.
    const styleItemCells = (cells: RowCells) => {
      cells.sCell.alignment = { horizontal: "left", vertical: "middle" };
      cells.sCell.border = allBorders;
      for (const c of [cells.qCell, cells.mCell, cells.uCell, cells.dCell, cells.gCell, cells.fCell, cells.oCell, cells.tCell]) {
        c.alignment = { horizontal: "right", vertical: "middle" };
        c.border = allBorders;
      }
      for (const c of [cells.mCell, cells.uCell]) if (typeof c.value === "number") c.numFmt = '₹#,##0';
      for (const c of [cells.fCell, cells.oCell, cells.tCell]) if (typeof c.value === "number") c.numFmt = MONEY_FMT;
      if (typeof cells.gCell.value === "number") cells.gCell.numFmt = '0.##"%"';
    };

    // Writes the GST % / Freight / Other Charges / Total cells from resolved values.
    const writeChargeCells = (cells: RowCells, r: { gstPercent: number | null; freight: number; otherCharges: number; total: number }) => {
      cells.gCell.value = r.gstPercent ?? "";
      cells.fCell.value = r.freight > 0 ? r.freight : "-";
      cells.oCell.value = r.otherCharges > 0 ? r.otherCharges : "-";
      cells.tCell.value = r.total;
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
        cell.alignment = { horizontal: offset === 0 ? "left" : "right", vertical: "middle", wrapText: true };
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

    const sum = (items: ResolvedItem[], pick: (r: ResolvedItem) => number) =>
      Math.round(items.reduce((a, r) => a + pick(r), 0) * 100) / 100;
    const uniformValue = <T,>(values: T[]): T | null =>
      values.length > 0 && values.every((v) => v === values[0]) ? values[0] : null;

    // ── Item rows, one per category ────────────────────────────────────
    for (const row of result.rows) {
      const excelRow = ws.addRow([]);
      excelRow.height = 16;
      const origRowIdx = rowIndexByCategory.get(row.category) ?? -1;

      const catCell = excelRow.getCell(CAT_COL);
      catCell.value = row.category;
      catCell.font  = boldBlack;
      catCell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: GRAY_FILL } };
      catCell.border = allBorders;

      // All-in (incl. charges and GST) total per vendor for this category; the lowest gets the green highlight
      const resolvedFor = (vendorId: number): ResolvedItem[] => resolutions.get(vendorId)?.rowItems[origRowIdx] ?? [];
      const totalByVendor = new Map<number, number>();
      for (const v of row.vendors) {
        const r = resolvedFor(v.quotationId);
        if (v.available && r.length > 0) totalByVendor.set(v.quotationId, sum(r, (x) => x.total));
      }
      const prices = [...totalByVendor.values()];
      const minPrice = prices.length ? Math.min(...prices) : null;

      doneVendors.forEach((vendor, vi) => {
        const vr  = row.vendors.find((v) => v.quotationId === vendor.id);
        const resolved = resolvedFor(vendor.id);
        const isLowest = vr?.available && totalByVendor.get(vendor.id) === minPrice && minPrice != null;
        // Format only carries over unambiguously when exactly one line item makes up this row.
        const soleItem: VendorLineItem | undefined = vr?.lineItems.length === 1 ? vr.lineItems[0] : undefined;

        const cells = cellsFor(excelRow, vi);
        const { sCell, qCell, mCell, uCell, dCell, tCell } = cells;

        if (vr?.available) {
          sCell.value = vr.vendorItemName
            ? `${vr.vendorItemName}${vr.spec ? " — " + vr.spec : ""}`
            : (vr.spec ?? "");
          qCell.value = vr.quantity ?? "";
          mCell.value = vr.mrp ?? "";
          uCell.value = vr.unitPrice ?? "";
          dCell.value = vr.discountPercent != null ? `${vr.discountPercent}%` : "";
          writeChargeCells(cells, {
            gstPercent: uniformValue(resolved.map((r) => r.gstPercent)),
            freight: sum(resolved, (r) => r.freight),
            otherCharges: sum(resolved, (r) => r.otherCharges),
            total: sum(resolved, (r) => r.total),
          });
        }

        styleItemCells(cells);

        if (isLowest) {
          tCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN_FILL } };
          tCell.font = { bold: true, color: { argb: "FF375623" } };
        }

        if (soleItem) {
          applyRowFormat(cells, soleItem.format);
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
            const itemResolved = resolvedFor(vendor.id)[li];
            const cells = cellsFor(variantRow, vi);
            const { sCell, qCell, mCell, uCell, dCell } = cells;

            if (item) {
              sCell.value = `${item.vendorItemName}${item.spec ? " — " + item.spec : ""}`;
              qCell.value = item.quantity;
              mCell.value = item.mrp ?? "";
              uCell.value = item.unitPrice;
              dCell.value = item.discountPercent != null ? `${item.discountPercent}%` : "";
              if (itemResolved) writeChargeCells(cells, itemResolved);
            }

            styleItemCells(cells);
            for (const c of [sCell, qCell, mCell, uCell, dCell, cells.gCell, cells.fCell, cells.oCell, cells.tCell]) {
              c.font = { italic: true, size: 8, color: { argb: "FF666666" } };
            }

            if (item) {
              applyRowFormat(cells, item.format, item.format?.vendorItemName);
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
          const itemResolved = resolutions.get(vendor.id)?.otherResolved[oi];
          const cells = cellsFor(itemRow, vi);
          const { sCell, qCell, mCell, uCell, dCell } = cells;

          if (item) {
            sCell.value = `${item.vendorItemName}${item.spec ? " — " + item.spec : ""}`;
            qCell.value = item.quantity;
            mCell.value = item.mrp ?? "";
            uCell.value = item.unitPrice;
            dCell.value = item.discountPercent != null ? `${item.discountPercent}%` : "";
            if (itemResolved) writeChargeCells(cells, itemResolved);
          }

          styleItemCells(cells);
          for (const c of [sCell, qCell, mCell, uCell, dCell, cells.gCell, cells.fCell, cells.oCell, cells.tCell]) {
            c.font = { italic: true, size: 8, color: { argb: "FF666666" } };
          }

          if (item) {
            applyRowFormat(cells, item.format, item.format?.vendorItemName);
          }
          writeCustomFields(itemRow, vi, item?.customFields, item?.format);
        });
      }
    }

    // ── Lump-sum charges quoted below the items (designing, freight, installation) ──
    // Shown as their own rows (not spread across the item rows), taxed at the vendor's GST rate.
    const lumpKeys = (["designingCharges", "freight", "installation"] as const).filter((k) =>
      doneVendors.some((v) => resolutions.get(v.id)?.lumpCharges.some((l) => l.key === k)));
    if (lumpKeys.length > 0) {
      ws.addRow([]).height = 4;
      for (const key of lumpKeys) {
        const lumpRow = ws.addRow([]);
        lumpRow.height = 16;
        const lc = lumpRow.getCell(CAT_COL);
        lc.value = CHARGE_LABELS[key];
        lc.font = { bold: true, italic: true };
        lc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GRAY_FILL } };
        lc.border = allBorders;

        let longestNote = 0;
        doneVendors.forEach((vendor, vi) => {
          const lump = resolutions.get(vendor.id)?.lumpCharges.find((l) => l.key === key);
          const cells = cellsFor(lumpRow, vi);
          if (lump) {
            const suffix = lump.status === "included" ? " — no separate charge" : lump.status === "unclear" ? " — no lump amount stated, nothing added" : "";
            const note = (lump.basis ? "As quoted: " + lump.basis : "") + suffix;
            cells.sCell.value = note;
            longestNote = Math.max(longestNote, note.length);
            if (lump.status === "amount") {
              cells.gCell.value = lump.gstPercent;
              (key === "freight" ? cells.fCell : cells.oCell).value = lump.amount;
              cells.tCell.value = lump.total;
            }
          }
          styleItemCells(cells);
          cells.sCell.font = { italic: true, size: 8, color: { argb: "FF666666" } };
          cells.sCell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
          // the note spans Spec..Disc %
          ws.mergeCells(lumpRow.number, specCol(vi), lumpRow.number, discCol(vi));
          writeCustomFields(lumpRow, vi, undefined, undefined);
        });
        // the note spans about 45 characters per line (Spec..Disc %) — grow the row to fit it
        lumpRow.height = Math.max(16, Math.ceil(longestNote / 45) * 11 + 5);
      }
    }

    // ── Terms rows (lead time, samples, payment, warranty) ───────────
    // GST, freight, installation and designing are not listed here as free text — they're
    // calculated into the GST % / Freight / Other Charges / Total columns above.
    ws.addRow([]).height = 8;

    const CHARGE_LABELS_IN_COLUMNS = new Set(["Designing Charges", "GST", "Installation", "Freight / Cartage"]);
    for (const info of result.additionalInfo.filter((i) => !CHARGE_LABELS_IN_COLUMNS.has(i.label))) {
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

    // ── Grand total ──────────────────────────────────────────────────
    // Calculated by us (sum of every row's Total, which includes its charges and GST), not copied
    // from the vendor's own total, since vendors make arithmetic mistakes.
    ws.addRow([]).height = 8;
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
      cell.value = resolutions.get(_v.id)?.grandTotal ?? "";
      cell.numFmt = MONEY_FMT;
      cell.font  = { bold: true, size: 11, color: { argb: WHITE } };
      cell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: DARK_BLUE } };
      cell.alignment = { horizontal: "right", vertical: "middle" };
      cell.border = allBorders;
      ws.mergeCells(gtRow.number, sc, gtRow.number, sc + NUM_DATA_COLS - 1);
    });

    // How the grand total is made up, and whether the GST rate was the vendor's or our assumption
    const breakdownRow = ws.addRow([]);
    breakdownRow.height = 28;
    const bdLabel = breakdownRow.getCell(CAT_COL);
    bdLabel.value = "Made up of";
    bdLabel.font = { italic: true, bold: true };
    bdLabel.border = allBorders;

    doneVendors.forEach((_v, vi) => {
      const sc = vendorStartCol(vi);
      const res = resolutions.get(_v.id);
      const cell = breakdownRow.getCell(sc);
      cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
      cell.border = allBorders;
      cell.font = { size: 9 };
      if (res) {
        const parts = [`Items ${rupees(res.baseTotal)}`];
        if (res.freightTotal > 0) parts.push(`Freight ${rupees(res.freightTotal)}`);
        if (res.otherTotal > 0) parts.push(`Other charges ${rupees(res.otherTotal)}`);
        parts.push(`GST ${rupees(res.gstTotal)}`);
        let text = parts.join(" + ");
        if (res.charges.gst.assumed) {
          text += `\nGST not stated by vendor — standard ${res.charges.gst.rate}% assumed`;
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: AMBER_FILL } };
        } else if (res.charges.gst.included) {
          text += "\nVendor's prices already include GST";
        }
        cell.value = text;
      }
      ws.mergeCells(breakdownRow.number, sc, breakdownRow.number, sc + NUM_DATA_COLS - 1);
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
      const calc = resolutions.get(_v.id)?.grandTotal;
      const parsed = _v.parsedData ? (JSON.parse(_v.parsedData) as ParsedQuotation) : null;
      const vendorTotal = parsed?.grandTotal ?? null;
      const cell = checkRow.getCell(sc);
      cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
      cell.border = allBorders;
      cell.font = { size: 9 };
      if (calc == null || vendorTotal == null) {
        cell.value = "Vendor's own total not available to compare";
      } else if (Math.abs(calc - vendorTotal) <= TOTAL_TOLERANCE) {
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
      ws.getColumn(gstCol(vi)).width = 8;
      ws.getColumn(freightCol(vi)).width = 12;
      ws.getColumn(otherCol(vi)).width = 12;
      ws.getColumn(totalCol(vi)).width = 16;
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
