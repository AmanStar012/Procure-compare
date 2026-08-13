import type { ParsedQuotation, ParsedItem, ItemFormatMap } from "./parse-quotation.js";
import type { Quotation } from "@workspace/db";

export interface VendorLineItem {
  vendorItemName: string;
  spec: string | null;
  quantity: number;
  mrp: number | null;
  unitPrice: number;
  discountPercent: number | null;
  totalPrice: number;
  format?: ItemFormatMap;
  customFields?: Record<string, string>;
}

export interface VendorRow {
  quotationId: number;
  vendorName: string;
  vendorItemName: string | null;
  spec: string | null;
  quantity: number | null;
  mrp: number | null;
  unitPrice: number | null;
  discountPercent: number | null;
  totalPrice: number | null;
  available: boolean;
  lineItems: VendorLineItem[];
}

export interface ComparisonRow {
  category: string;
  vendors: VendorRow[];
}

export interface OtherItem {
  quotationId: number;
  vendorName: string;
  vendorItemName: string;
  spec: string | null;
  quantity: number;
  mrp: number | null;
  unitPrice: number;
  discountPercent: number | null;
  totalPrice: number;
  format?: ItemFormatMap;
  customFields?: Record<string, string>;
}

export interface AdditionalVendorValue {
  quotationId: number;
  vendorName: string;
  value: string | null;
}

export interface ComparisonAdditional {
  label: string;
  vendors: AdditionalVendorValue[];
}

export interface GrandTotal {
  quotationId: number;
  vendorName: string;
  total: number | null;
}

export interface VendorDetail {
  quotationId: number;
  vendorName: string;
  vendorAddress: string | null;
  vendorContact: string | null;
  isBenchmark: boolean;
}

export interface ComparisonResult {
  projectId: number;
  vendors: Quotation[];
  vendorDetails: VendorDetail[];
  rows: ComparisonRow[];
  otherItems: OtherItem[];
  additionalInfo: ComparisonAdditional[];
  grandTotals: GrandTotal[];
}

export function buildComparison(projectId: number, quotations: Quotation[], targetItems: string[]): ComparisonResult {
  const parsed = quotations
    .filter((q) => q.status === "done" && q.parsedData)
    .map((q) => ({
      quotation: q,
      data: JSON.parse(q.parsedData!) as ParsedQuotation,
    }));

  if (parsed.length === 0) {
    return { projectId, vendors: quotations, vendorDetails: [], rows: [], otherItems: [], additionalInfo: [], grandTotals: [] };
  }

  // A vendor may quote several size/variant line items under one category (e.g. seven
  // nameplate sizes all under "Silver Plastic Nameplate"). Returns the shared value only
  // when every match agrees on it — otherwise null, since a single number can't represent
  // differing rates/specs (the per-variant breakdown is preserved in lineItems instead).
  const uniform = <T,>(values: T[]): T | null =>
    values.length > 0 && values.every((v) => v === values[0]) ? values[0] : null;

  // One row per target category (in the project's defined order), regardless of
  // whether every vendor offers it. Each vendor's own spec (capacity/size/model)
  // is shown per-cell rather than used to split rows — vendors describe the same
  // requirement differently (capacity vs. voltage vs. nothing at all), so grouping
  // by spec text would fragment a single comparable item into several rows.
  const rows: ComparisonRow[] = targetItems.map((category) => {
    const vendors: VendorRow[] = parsed.map(({ quotation, data }) => {
      const matches = data.items.filter((item: ParsedItem) => item.matchedCategory === category);
      const lineItems: VendorLineItem[] = matches.map((item) => ({
        vendorItemName: item.vendorItemName,
        spec: item.spec,
        quantity: item.quantity,
        mrp: item.mrp,
        unitPrice: item.unitPrice,
        discountPercent: item.discountPercent,
        totalPrice: item.totalPrice,
        format: item.format,
        customFields: item.customFields,
      }));

      if (matches.length === 0) {
        return {
          quotationId: quotation.id,
          vendorName: quotation.vendorName,
          vendorItemName: null,
          spec: null,
          quantity: null,
          mrp: null,
          unitPrice: null,
          discountPercent: null,
          totalPrice: null,
          available: false,
          lineItems,
        };
      }

      return {
        quotationId: quotation.id,
        vendorName: quotation.vendorName,
        vendorItemName: uniform(matches.map((m) => m.vendorItemName)),
        spec: uniform(matches.map((m) => m.spec)),
        quantity: matches.reduce((sum, m) => sum + m.quantity, 0),
        mrp: uniform(matches.map((m) => m.mrp)),
        unitPrice: uniform(matches.map((m) => m.unitPrice)),
        discountPercent: uniform(matches.map((m) => m.discountPercent)),
        totalPrice: matches.reduce((sum, m) => sum + m.totalPrice, 0),
        available: true,
        lineItems,
      };
    });
    return { category, vendors };
  });

  // Other items: line items that didn't match any target category. Also catches items
  // matched to a category that has since been renamed/removed from the project's tags —
  // otherwise a tag edit would silently make that vendor's data disappear entirely.
  const targetItemSet = new Set(targetItems);
  const otherItems: OtherItem[] = parsed.flatMap(({ quotation, data }) =>
    data.items
      .filter((item) => item.matchedCategory === null || !targetItemSet.has(item.matchedCategory))
      .map((item) => ({
        quotationId: quotation.id,
        vendorName: quotation.vendorName,
        vendorItemName: item.vendorItemName,
        spec: item.spec,
        quantity: item.quantity,
        mrp: item.mrp,
        unitPrice: item.unitPrice,
        discountPercent: item.discountPercent,
        totalPrice: item.totalPrice,
        format: item.format,
        customFields: item.customFields,
      })),
  );

  // Additional info rows
  const infoKeys: Array<{ label: string; key: keyof ParsedQuotation["additionalInfo"] }> = [
    { label: "Designing Charges", key: "designingCharges" },
    { label: "GST", key: "gst" },
    { label: "Installation", key: "installation" },
    { label: "Freight / Cartage", key: "freight" },
    { label: "Lead Time", key: "leadTime" },
    { label: "Samples for Review", key: "samplesForReview" },
    { label: "Payment Schedule", key: "paymentSchedule" },
    { label: "Warranty", key: "warranty" },
  ];

  const additionalInfo: ComparisonAdditional[] = infoKeys.map(({ label, key }) => ({
    label,
    vendors: parsed.map(({ quotation, data }) => ({
      quotationId: quotation.id,
      vendorName: quotation.vendorName,
      value: data.additionalInfo?.[key] ?? null,
    })),
  }));

  // Grand totals
  const grandTotals: GrandTotal[] = parsed.map(({ quotation, data }) => ({
    quotationId: quotation.id,
    vendorName: quotation.vendorName,
    total: data.grandTotal ?? null,
  }));

  // Vendor details (name + address + contact from parsed data)
  const vendorDetails: VendorDetail[] = parsed.map(({ quotation, data }) => ({
    quotationId: quotation.id,
    vendorName: data.vendorName || quotation.vendorName,
    vendorAddress: data.vendorAddress ?? null,
    vendorContact: data.vendorContact ?? null,
    isBenchmark: quotation.isBenchmark,
  }));

  return { projectId, vendors: quotations, vendorDetails, rows, otherItems, additionalInfo, grandTotals };
}
