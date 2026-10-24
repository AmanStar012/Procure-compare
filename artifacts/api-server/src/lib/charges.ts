// Independently recomputes a vendor's charges and grand total from their line items and
// the charge text they quoted (GST, freight, installation, designing), instead of trusting
// the total printed on the vendor's own document — vendors make arithmetic mistakes.
//
// NOTE: artifacts/quotation-compare/src/lib/charges.ts is a copy of this file (the two
// packages don't share code). Keep them in sync.

export type ChargeKey = "designingCharges" | "freight" | "installation"

export const CHARGE_KEYS: readonly ChargeKey[] = ["designingCharges", "freight", "installation"]

export const CHARGE_LABELS: Record<ChargeKey | "gst", string> = {
  designingCharges: "Designing Charges",
  freight: "Freight / Cartage",
  installation: "Installation",
  gst: "GST",
}

// A charge that is already a priced line item (e.g. "Freight Charges (Gurgaon)") must not be
// added a second time from the additional-info text.
const ITEMISED_PATTERN: Record<ChargeKey, RegExp> = {
  designingCharges: /design/i,
  freight: /freight|cartage|transport|logistic|delivery/i,
  installation: /install|fixing|erection|commissioning/i,
}

// Structural so both the parsed-quotation interface and plain records can be passed in.
export type ChargeInfoLike = Partial<Record<ChargeKey | "gst", string | null>>

export interface ChargeItemLike {
  vendorItemName: string
  totalPrice: number
}

export interface ChargeLine {
  key: ChargeKey
  label: string
  basis: string | null
  amount: number // what this row adds on top of the items subtotal
  itemisedAmount: number // when > 0 the charge is already one of the line items, so `amount` is 0
  waived: boolean // text says included / free
  unclear: boolean // the vendor wrote something but no usable amount could be read from it
}

export interface GstLine {
  basis: string | null
  rate: number | null // percent, when the vendor quoted GST as a percentage
  amount: number
  included: boolean // vendor says prices already include GST
  assumed: boolean // vendor didn't state a usable rate, so DEFAULT_GST_RATE was applied
}

export interface ChargeBreakdown {
  itemsSubtotal: number
  lines: ChargeLine[]
  taxableValue: number // items + charges, before GST
  gst: GstLine
  grandTotal: number
}

export const DEFAULT_GST_RATE = 18

// Our total can differ from the vendor's by a rupee or two just from rounding each row to paise;
// anything beyond this is treated as a real difference worth flagging.
export const TOTAL_TOLERANCE = 2

const round2 = (n: number) => Math.round(n * 100) / 100
const toNumber = (s: string) => parseFloat(s.replace(/,/g, ""))

const WAIVED = /\b(included|inclusive|incl\.?|free|nil|complimentary|no charges?)\b/i

function parsePercent(raw: string): number | null {
  const m = raw.match(/(\d[\d,]*\.?\d*)\s*%/)
  return m ? toNumber(m[1]) : null
}

// GST can be quoted as one rate ("GST 18%", "IGST @ 18%") or split into two halves that must be
// added: "CGST 9% + SGST 9%", "9% CGST + 9% SGST", "CGST + SGST @ 9% each", "CGST + IGST 9% + 9%".
// (UTGST stands in for SGST in union territories.)
const GST_PART_RATE = /(cgst|sgst|utgst|igst)\b(?:(?!cgst|sgst|utgst|igst)[^0-9%]){0,14}?(\d+(?:\.\d+)?)\s*%|(\d+(?:\.\d+)?)\s*%\s*(?:of\s+)?(cgst|sgst|utgst|igst)\b/gi

function parseGstRate(raw: string): number | null {
  const norm = (p: string) => (p.toLowerCase() === "utgst" ? "sgst" : p.toLowerCase())
  const paired = new Map<string, number>()
  for (const m of raw.matchAll(GST_PART_RATE)) paired.set(norm(m[1] ?? m[4]), parseFloat(m[2] ?? m[3]))
  const named = new Set((raw.match(/\b(?:cgst|sgst|utgst|igst)\b/gi) ?? []).map(norm))
  const pcts = (raw.match(/\d+(?:\.\d+)?(?=\s*%)/g) ?? []).map(Number)

  if (named.size >= 2) {
    // every named part sits next to its own rate
    if (paired.size === named.size) return round2([...paired.values()].reduce((a, b) => a + b, 0))
    // one rate that applies to each part
    if (/\b(?:each|respectively)\b/i.test(raw) && pcts.length >= 1) return round2(pcts[0] * named.size)
    // the rates listed in order, without being paired to a name: "CGST + SGST 9% + 9%"
    if (pcts.length >= named.size) return round2(pcts.slice(0, named.size).reduce((a, b) => a + b, 0))
  }
  if (paired.size === 1) return [...paired.values()][0]
  return parsePercent(raw)
}

// A rate such as "INR 100 per window" or "₹50/sqft" is not a lump-sum charge.
const PER_UNIT = /\bper\b|\beach\b|\bevery\b|\/\s*(?:sq\.?\s*ft|sqft|sft|sq\.?\s*m|unit|pc|pcs|piece|window|door|visit|day|hr|hour|mtr|meter|metre|kg|ton)\b/i

// Reads a lump-sum amount out of free text such as "₹2,000", "12,000.00 (Gurgaon)" or
// "Freight Charges - 12,000.00". Returns null when the text is a rate, or mentions several
// different figures, or the one figure doesn't look like an amount — better to show the vendor's
// wording and add nothing than to guess a number out of a sentence.
function parseFlatAmount(raw: string): number | null {
  if (PER_UNIT.test(raw)) return null
  const nums = (raw.match(/\d[\d,]*\.?\d*/g) ?? []).map(toNumber).filter((n) => !Number.isNaN(n))
  const distinct = [...new Set(nums)]
  if (distinct.length !== 1) return null
  const marked = /(?:₹|rs\.?|inr)\s*\d/i.test(raw)
  const looksLikeAmount = marked || distinct[0] >= 1000 || /\d,\d|\.\d/.test(raw) || raw.trim().length <= 30
  return looksLikeAmount ? distinct[0] : null
}

export function computeCharges(
  items: ChargeItemLike[],
  additionalInfo: ChargeInfoLike | null | undefined,
): ChargeBreakdown {
  const info = additionalInfo ?? {}
  const itemsSubtotal = round2(items.reduce((sum, it) => sum + (it.totalPrice || 0), 0))

  const lines: ChargeLine[] = CHARGE_KEYS.map((key) => {
    const basis = info[key] ?? null
    const itemised = items.filter((it) => ITEMISED_PATTERN[key].test(it.vendorItemName))
    const itemisedAmount = round2(itemised.reduce((sum, it) => sum + (it.totalPrice || 0), 0))
    const base = { key, label: CHARGE_LABELS[key], basis }

    if (itemised.length > 0) return { ...base, amount: 0, itemisedAmount, waived: false, unclear: false }
    if (!basis) return { ...base, amount: 0, itemisedAmount: 0, waived: false, unclear: false }
    if (WAIVED.test(basis)) return { ...base, amount: 0, itemisedAmount: 0, waived: true, unclear: false }

    const pct = parsePercent(basis)
    if (pct != null) return { ...base, amount: round2((itemsSubtotal * pct) / 100), itemisedAmount: 0, waived: false, unclear: false }
    const flat = parseFlatAmount(basis)
    if (flat == null) return { ...base, amount: 0, itemisedAmount: 0, waived: false, unclear: true }
    return { ...base, amount: round2(flat), itemisedAmount: 0, waived: false, unclear: false }
  })

  const taxableValue = round2(itemsSubtotal + lines.reduce((sum, l) => sum + l.amount, 0))

  // GST in India is 18% for nearly everything quoted here, so when a vendor doesn't state a
  // rate we assume it (and say so) rather than silently leaving GST out of the total.
  const gstBasis = info.gst ?? null
  const assumedGst = (): GstLine => ({
    basis: gstBasis, rate: DEFAULT_GST_RATE, amount: round2((taxableValue * DEFAULT_GST_RATE) / 100), included: false, assumed: true,
  })
  let gst: GstLine = assumedGst()
  if (gstBasis) {
    const included = /\b(included|inclusive|incl\.?)\b/i.test(gstBasis)
    const exempt = /\b(nil|exempt(ed)?|not applicable|n\/a|no gst)\b/i.test(gstBasis)
    const pct = parseGstRate(gstBasis)
    if (included) {
      gst = { basis: gstBasis, rate: pct, amount: 0, included: true, assumed: false }
    } else if (pct != null) {
      gst = { basis: gstBasis, rate: pct, amount: round2((taxableValue * pct) / 100), included: false, assumed: false }
    } else if (exempt) {
      gst = { basis: gstBasis, rate: 0, amount: 0, included: false, assumed: false }
    } else {
      const flat = parseFlatAmount(gstBasis)
      const hasCurrencyMarker = /(?:₹|rs\.?|inr)/i.test(gstBasis)
      // A bare small number with no currency marker ("GST 18") is a rate, not an amount.
      if (flat != null && !hasCurrencyMarker && flat <= 30 && Number.isInteger(flat)) {
        gst = { basis: gstBasis, rate: flat, amount: round2((taxableValue * flat) / 100), included: false, assumed: false }
      } else if (flat != null) {
        gst = { basis: gstBasis, rate: null, amount: round2(flat), included: false, assumed: false }
      }
      // else: wording only ("as applicable") — keep the assumed 18%
    }
  }

  return { itemsSubtotal, lines, taxableValue, gst, grandTotal: round2(taxableValue + gst.amount) }
}

// ── Per-row view ───────────────────────────────────────────────────────────
// The table shows GST %, Freight and Other Charges as columns on every item row, with Total
// = base amount + freight + other charges + GST. A row's own value (typed by the user, stored on
// the item) wins; otherwise GST defaults to the vendor's rate (or 18%) and freight/other to 0.
// A lump-sum charge the vendor quoted separately (e.g. "Freight: ₹12,000" at the bottom of their
// quote) is NOT spread over the item rows — it comes back as its own row in `lumpCharges`.

export interface ResolveItemInput extends ChargeItemLike {
  gstPercent?: number | null
  freight?: number | null
  otherCharges?: number | null
}

export interface ResolvedItem {
  base: number // the line amount before charges and GST (what's stored as totalPrice)
  gstPercent: number
  gstAmount: number
  freight: number
  otherCharges: number
  total: number // base + freight + otherCharges + gstAmount
}

// A charge the vendor quoted as one lump sum, shown as its own row below the items.
export interface LumpCharge {
  key: ChargeKey
  label: string
  basis: string | null // what the vendor wrote, e.g. "₹12,000" or "2%"
  // "amount": a charge that is added; "included": the vendor says no separate charge;
  // "unclear": they wrote something (e.g. a per-unit rate) but no lump amount could be read — nothing is added.
  status: "amount" | "included" | "unclear"
  amount: number // before GST (0 unless status is "amount")
  gstPercent: number
  gstAmount: number
  total: number // amount + gstAmount
}

export interface VendorResolution {
  charges: ChargeBreakdown // vendor-level view: lump sums found, GST rate and whether it was assumed
  items: ResolvedItem[] // aligned with the input items
  lumpCharges: LumpCharge[] // lump-sum charges not already part of the items (own rows, included in the totals)
  baseTotal: number
  freightTotal: number
  otherTotal: number
  gstTotal: number
  grandTotal: number
}

export function resolveItems(items: ResolveItemInput[], additionalInfo: ChargeInfoLike | null | undefined): VendorResolution {
  const charges = computeCharges(items, additionalInfo)
  const bases = items.map((it) => it.totalPrice || 0)

  // The vendor's GST as a rate; a flat amount they stated is turned into its implied rate.
  const impliedRate = charges.taxableValue > 0 ? round2((charges.gst.amount / charges.taxableValue) * 100) : 0
  const defaultRate = charges.gst.included ? 0 : (charges.gst.rate ?? impliedRate)

  const resolved: ResolvedItem[] = items.map((it, i) => {
    const base = bases[i]
    const freight = it.freight ?? 0
    const otherCharges = it.otherCharges ?? 0
    const gstPercent = it.gstPercent ?? defaultRate
    const gstAmount = round2(((base + freight + otherCharges) * gstPercent) / 100)
    return { base, gstPercent, gstAmount, freight, otherCharges, total: round2(base + freight + otherCharges + gstAmount) }
  })

  // Lump-sum charges (not already priced as an item) become their own rows, taxed at the same rate.
  const lumpCharges: LumpCharge[] = charges.lines
    .filter((l) => l.amount > 0 || l.waived || l.unclear)
    .map((l) => {
      const status: LumpCharge["status"] = l.amount > 0 ? "amount" : l.waived ? "included" : "unclear"
      const gstAmount = round2((l.amount * defaultRate) / 100)
      return { key: l.key, label: l.label, basis: l.basis, status, amount: l.amount, gstPercent: defaultRate, gstAmount, total: round2(l.amount + gstAmount) }
    })

  const sum = (pick: (r: ResolvedItem) => number) => round2(resolved.reduce((a, r) => a + pick(r), 0))
  const lumpSum = (pick: (l: LumpCharge) => number, only?: (l: LumpCharge) => boolean) =>
    round2(lumpCharges.filter((l) => !only || only(l)).reduce((a, l) => a + pick(l), 0))
  return {
    charges,
    items: resolved,
    lumpCharges,
    baseTotal: sum((r) => r.base),
    freightTotal: round2(sum((r) => r.freight) + lumpSum((l) => l.amount, (l) => l.key === "freight")),
    otherTotal: round2(sum((r) => r.otherCharges) + lumpSum((l) => l.amount, (l) => l.key !== "freight")),
    gstTotal: round2(sum((r) => r.gstAmount) + lumpSum((l) => l.gstAmount)),
    grandTotal: round2(sum((r) => r.total) + lumpSum((l) => l.total)),
  }
}

// ── Whole-comparison helper ────────────────────────────────────────────────
// Structural, so it works on the server's comparison result and the generated client type alike.
export interface ComparisonLike {
  rows: { vendors: { quotationId: number; lineItems: ResolveItemInput[] }[] }[]
  otherItems: (ResolveItemInput & { quotationId: number })[]
  additionalInfo: { label: string; vendors: { quotationId: number; value?: string | null }[] }[]
}

export interface VendorComparisonResolution extends VendorResolution {
  rowItems: ResolvedItem[][] // per comparison row (same order), this vendor's resolved line items
  otherResolved: ResolvedItem[] // this vendor's "other items offered", resolved
}

export function resolveVendorInComparison(c: ComparisonLike, quotationId: number): VendorComparisonResolution {
  const flat: ResolveItemInput[] = []
  const rowCounts: number[] = []
  for (const row of c.rows) {
    const items = row.vendors.find((v) => v.quotationId === quotationId)?.lineItems ?? []
    rowCounts.push(items.length)
    flat.push(...items)
  }
  const others = c.otherItems.filter((o) => o.quotationId === quotationId)
  flat.push(...others)

  const info: ChargeInfoLike = {}
  for (const key of [...CHARGE_KEYS, "gst" as const]) {
    const row = c.additionalInfo.find((a) => a.label === CHARGE_LABELS[key])
    info[key] = row?.vendors.find((v) => v.quotationId === quotationId)?.value ?? null
  }

  const res = resolveItems(flat, info)
  const rowItems: ResolvedItem[][] = []
  let at = 0
  for (const n of rowCounts) {
    rowItems.push(res.items.slice(at, at + n))
    at += n
  }
  return { ...res, rowItems, otherResolved: res.items.slice(at) }
}
