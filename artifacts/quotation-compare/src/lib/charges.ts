// Independently recomputes a vendor's charges and grand total from their line items and
// the charge text they quoted (GST, freight, installation, designing), instead of trusting
// the total printed on the vendor's own document — vendors make arithmetic mistakes.
//
// NOTE: artifacts/api-server/src/lib/charges.ts is a copy of this file (the two
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
}

export interface GstLine {
  basis: string | null
  rate: number | null // percent, when the vendor quoted GST as a percentage
  amount: number
  included: boolean // vendor says prices already include GST
}

export interface ChargeBreakdown {
  itemsSubtotal: number
  lines: ChargeLine[]
  taxableValue: number // items + charges, before GST
  gst: GstLine
  grandTotal: number
}

const round2 = (n: number) => Math.round(n * 100) / 100
const toNumber = (s: string) => parseFloat(s.replace(/,/g, ""))

const WAIVED = /\b(included|inclusive|incl\.?|free|nil|complimentary|no charges?)\b/i

function parsePercent(raw: string): number | null {
  const m = raw.match(/(\d[\d,]*\.?\d*)\s*%/)
  return m ? toNumber(m[1]) : null
}

// Prefers an amount marked with a currency symbol, otherwise the last number in the text
// (e.g. "Freight Charges (Gurgaon) - 12,000.00" -> 12000).
function parseFlatAmount(raw: string): number | null {
  const marked = raw.match(/(?:₹|rs\.?|inr)\s*(\d[\d,]*\.?\d*)/i)
  if (marked) return toNumber(marked[1])
  const nums = raw.match(/\d[\d,]*\.?\d*/g)
  return nums ? toNumber(nums[nums.length - 1]) : null
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

    if (itemised.length > 0) return { ...base, amount: 0, itemisedAmount, waived: false }
    if (!basis) return { ...base, amount: 0, itemisedAmount: 0, waived: false }
    if (WAIVED.test(basis)) return { ...base, amount: 0, itemisedAmount: 0, waived: true }

    const pct = parsePercent(basis)
    const amount = pct != null ? (itemsSubtotal * pct) / 100 : (parseFlatAmount(basis) ?? 0)
    return { ...base, amount: round2(amount), itemisedAmount: 0, waived: false }
  })

  const taxableValue = round2(itemsSubtotal + lines.reduce((sum, l) => sum + l.amount, 0))

  const gstBasis = info.gst ?? null
  let gst: GstLine = { basis: gstBasis, rate: null, amount: 0, included: false }
  if (gstBasis) {
    const included = /\b(included|inclusive|incl\.?)\b/i.test(gstBasis)
    const pct = parsePercent(gstBasis)
    if (included) {
      gst = { basis: gstBasis, rate: pct, amount: 0, included: true }
    } else if (pct != null) {
      gst = { basis: gstBasis, rate: pct, amount: round2((taxableValue * pct) / 100), included: false }
    } else {
      const flat = parseFlatAmount(gstBasis)
      const hasCurrencyMarker = /(?:₹|rs\.?|inr)/i.test(gstBasis)
      // A bare small number with no currency marker ("GST 18") is a rate, not an amount.
      if (flat != null && !hasCurrencyMarker && flat <= 30 && Number.isInteger(flat)) {
        gst = { basis: gstBasis, rate: flat, amount: round2((taxableValue * flat) / 100), included: false }
      } else {
        gst = { basis: gstBasis, rate: null, amount: round2(flat ?? 0), included: false }
      }
    }
  }

  return { itemsSubtotal, lines, taxableValue, gst, grandTotal: round2(taxableValue + gst.amount) }
}
