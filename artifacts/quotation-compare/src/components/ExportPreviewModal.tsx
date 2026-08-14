import React, { useState, useMemo, useEffect, useCallback } from "react"
import { createPortal } from "react-dom"
import { useQueryClient } from "@tanstack/react-query"
import {
  useUpdateQuotation,
  useUpdateProject,
  getGetComparisonQueryKey,
  getListQuotationsQueryKey,
  getGetProjectSummaryQueryKey,
  getGetProjectQueryKey,
  type ComparisonResult,
  type ProjectDetail,
  type ColumnLabels,
  type CustomColumn,
} from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useToast } from "@/hooks/use-toast"
import { Download, X, Eye, RotateCcw, Plus, Trash2, Loader2, Save, Bold, Italic, Underline, Highlighter, Columns3 } from "lucide-react"

// ── Draft (editable) data model ────────────────────────────────────────────
const ADDITIONAL_INFO_LABELS: Record<string, string> = {
  designingCharges: "Designing Charges",
  gst: "GST",
  installation: "Installation",
  freight: "Freight / Cartage",
  leadTime: "Lead Time",
  samplesForReview: "Samples for Review",
  paymentSchedule: "Payment Schedule",
  warranty: "Warranty",
}
const LABEL_TO_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(ADDITIONAL_INFO_LABELS).map(([k, v]) => [v, k])
)
const ADDITIONAL_INFO_KEYS = Object.keys(ADDITIONAL_INFO_LABELS)

// Additional-info fields that represent a monetary charge (flat ₹ amount or a
// "%" applied to the items subtotal) and therefore feed into the Grand Total.
const CHARGE_KEYS = ["gst", "freight", "installation"] as const

const DEFAULT_COL_LABELS: Record<keyof ColumnLabels, string> = {
  spec: "Item / Spec",
  qty: "Qty",
  mrp: "MRP",
  unitPrice: "Rate",
  discountPercent: "Disc %",
  totalPrice: "Total",
}
const BUILTIN_COL_KEYS = Object.keys(DEFAULT_COL_LABELS) as (keyof ColumnLabels)[]

// Fixed pixel widths shared by the header row and every vendor's item rows —
// this is what keeps columns lined up under their headers (previously each
// used independent, mismatched % widths inside separate <table> elements).
const CATEGORY_COL_WIDTH = 180
const COL_WIDTH: Record<keyof ColumnLabels, number> = {
  spec: 220,
  qty: 60,
  mrp: 84,
  unitPrice: 84,
  discountPercent: 70,
  totalPrice: 100,
}
const CUSTOM_COL_WIDTH = 96

interface ItemFormatState {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  highlight?: boolean
}

// Per-column formatting for one item, keyed by field name (vendorItemName, spec,
// quantity, mrp, unitPrice, discountPercent, totalPrice) or a custom column id.
type ItemFormatMap = Record<string, ItemFormatState>

interface DraftItem {
  key: string
  matchedCategory: string | null
  vendorItemName: string
  spec: string | null
  quantity: number
  mrp: number | null
  unitPrice: number
  discountPercent: number | null
  totalPrice: number
  format: ItemFormatMap
  customFields: Record<string, string>
}

interface DraftVendor {
  quotationId: number
  vendorName: string
  vendorAddress: string | null
  vendorContact: string | null
  isBenchmark: boolean
  items: DraftItem[]
  additionalInfo: Record<string, string | null>
  grandTotal: number | null
}

let keySeq = 0
const nextKey = () => `item-${Date.now()}-${keySeq++}`

function buildInitialDraft(comparison: ComparisonResult, doneVendors: ComparisonResult["vendors"]): Record<number, DraftVendor> {
  const draft: Record<number, DraftVendor> = {}
  for (const v of doneVendors) {
    const detail = comparison.vendorDetails.find((d) => d.quotationId === v.id)
    const items: DraftItem[] = []
    for (const row of comparison.rows) {
      const vr = row.vendors.find((vv) => vv.quotationId === v.id)
      if (!vr) continue
      for (const li of vr.lineItems) {
        items.push({
          key: nextKey(),
          matchedCategory: row.category,
          vendorItemName: li.vendorItemName,
          spec: li.spec ?? null,
          quantity: li.quantity,
          mrp: li.mrp ?? null,
          unitPrice: li.unitPrice,
          discountPercent: li.discountPercent ?? null,
          totalPrice: li.totalPrice,
          format: { ...(li as any).format },
          customFields: { ...(li as any).customFields },
        })
      }
    }
    for (const oi of comparison.otherItems) {
      if (oi.quotationId !== v.id) continue
      items.push({
        key: nextKey(),
        matchedCategory: null,
        vendorItemName: oi.vendorItemName,
        spec: oi.spec ?? null,
        quantity: oi.quantity,
        mrp: oi.mrp ?? null,
        unitPrice: oi.unitPrice,
        discountPercent: oi.discountPercent ?? null,
        totalPrice: oi.totalPrice,
        format: { ...(oi as any).format },
        customFields: { ...(oi as any).customFields },
      })
    }

    const additionalInfo: Record<string, string | null> = {}
    for (const info of comparison.additionalInfo) {
      const key = LABEL_TO_KEY[info.label]
      if (!key) continue
      additionalInfo[key] = info.vendors.find((iv) => iv.quotationId === v.id)?.value ?? null
    }

    draft[v.id] = {
      quotationId: v.id,
      vendorName: detail?.vendorName ?? v.vendorName,
      vendorAddress: detail?.vendorAddress ?? null,
      vendorContact: detail?.vendorContact ?? null,
      isBenchmark: detail?.isBenchmark ?? v.isBenchmark,
      items,
      additionalInfo,
      grandTotal: comparison.grandTotals.find((g) => g.quotationId === v.id)?.total ?? null,
    }
  }
  return draft
}

interface Props {
  open: boolean
  onClose: () => void
  comparison: ComparisonResult
  project: ProjectDetail
  projectId: number
  basePath: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt = (n: number | null | undefined) => {
  if (n == null) return "-"
  return "₹ " + new Intl.NumberFormat("en-IN").format(n)
}

// Comma-grouped display for a numeric cell, e.g. 31463.41 -> "31,463.41".
const formatNumberForDisplay = (value: string | number | null | undefined) => {
  if (value === "" || value == null) return ""
  const num = typeof value === "number" ? value : Number(value)
  if (Number.isNaN(num)) return String(value)
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(num)
}

// Best-effort read of a free-text additional-info field (e.g. "18%", "₹2,000",
// "Included") as a monetary contribution — a "%" is applied against the items
// subtotal, a plain number is taken as a flat amount, anything else is 0.
const parseChargeAmount = (raw: string | null | undefined, base: number): number => {
  if (!raw) return 0
  const percentMatch = raw.match(/(-?\d[\d,]*\.?\d*)\s*%/)
  if (percentMatch) return (base * parseFloat(percentMatch[1].replace(/,/g, ""))) / 100
  const flatMatch = raw.match(/(-?\d[\d,]*\.?\d*)/)
  if (flatMatch) return parseFloat(flatMatch[1].replace(/,/g, ""))
  return 0
}

const computeGrandTotal = (v: DraftVendor): number => {
  const itemsSubtotal = v.items.reduce((sum, it) => sum + (it.totalPrice || 0), 0)
  const extra = CHARGE_KEYS.reduce((sum, k) => sum + parseChargeAmount(v.additionalInfo[k], itemsSubtotal), 0)
  return Math.round((itemsSubtotal + extra) * 100) / 100
}

const formatClasses = (f: ItemFormatState | undefined) =>
  [
    f?.bold ? "font-bold" : "",
    f?.italic ? "italic" : "",
    f?.underline ? "underline" : "",
    f?.highlight ? "bg-yellow-100 dark:bg-yellow-900/30" : "",
  ].join(" ")

const textCell = "w-full bg-transparent border-0 border-b border-dashed border-transparent hover:border-muted-foreground/40 focus:border-primary focus:outline-none px-1 py-0.5 text-xs"
const numCell = textCell + " text-right tabular-nums"

let colSeq = 0
const nextColId = () => `col-${Date.now()}-${colSeq++}`

// ── Cell components (module scope — see note below) ────────────────────────
// FormatCell/CategorySelect/CustomFieldCells used to be declared *inside*
// ExportPreviewModal's render body. That meant a brand-new function (and thus
// a brand-new React component "type") on every keystroke, so React unmounted
// and remounted the underlying <input> on every change — killing focus mid-type.
// That's why typing felt broken enough that the native number spinner's
// increment/decrement clicks (which don't rely on sustained focus) became the
// workaround. Declaring them here, at module scope, keeps the component type
// stable across renders so React only updates props in place.

interface FormatCellProps {
  qid: number
  item: DraftItem
  field: string
  value: string | number
  onChange: (raw: string) => void
  onToggleFormat: (qid: number, key: string, field: string, flag: keyof ItemFormatState) => void
  type?: "text" | "number"
  placeholder?: string
  inputClassName?: string
}

// One value input + a tiny per-column B/I/U/highlight toolbar that only shows on
// hover/focus of THIS cell — so formatting targets one column, not the whole row.
function FormatCell({
  qid, item, field, value, onChange, onToggleFormat, type = "text", placeholder, inputClassName = "",
}: FormatCellProps) {
  const [focused, setFocused] = useState(false)
  const [draftText, setDraftText] = useState("")
  const isNumber = type === "number"
  const f = item.format[field]
  const base = isNumber ? numCell : textCell
  const btnClass = (active: boolean | undefined, activeClass: string) =>
    `p-[1px] rounded ${active ? activeClass : "text-muted-foreground/40 hover:text-foreground"}`
  // While focused, show exactly what's being typed (draftText) rather than the
  // parent's round-tripped number — otherwise e.g. a trailing "." gets stripped
  // on every keystroke and you can never type a decimal. Comma formatting only
  // applies once you click away.
  const displayValue = isNumber ? (focused ? draftText : formatNumberForDisplay(value)) : value
  return (
    <div className="group/fc relative">
      <input
        type="text"
        inputMode={isNumber ? "decimal" : undefined}
        value={displayValue}
        onFocus={() => {
          setFocused(true)
          setDraftText(value === "" || value == null ? "" : String(value))
        }}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          if (isNumber) {
            const cleaned = e.target.value.replace(/[^0-9.-]/g, "")
            setDraftText(cleaned)
            onChange(cleaned)
          } else {
            onChange(e.target.value)
          }
        }}
        placeholder={placeholder}
        className={`${base} ${formatClasses(f)} ${inputClassName}`}
      />
      <div className="flex items-center gap-0.5 justify-end h-3 opacity-0 group-hover/fc:opacity-100 group-focus-within/fc:opacity-100 transition-opacity">
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onToggleFormat(qid, item.key, field, "bold")} title="Bold" className={btnClass(f?.bold, "bg-primary/20 text-primary")}>
          <Bold className="w-2 h-2" />
        </button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onToggleFormat(qid, item.key, field, "italic")} title="Italic" className={btnClass(f?.italic, "bg-primary/20 text-primary")}>
          <Italic className="w-2 h-2" />
        </button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onToggleFormat(qid, item.key, field, "underline")} title="Underline" className={btnClass(f?.underline, "bg-primary/20 text-primary")}>
          <Underline className="w-2 h-2" />
        </button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onToggleFormat(qid, item.key, field, "highlight")} title="Highlight" className={btnClass(f?.highlight, "bg-yellow-200 text-yellow-800")}>
          <Highlighter className="w-2 h-2" />
        </button>
      </div>
    </div>
  )
}

// Standalone comma-formatted number input (no per-cell B/I/U toolbar) — used
// for the Grand Total row. Shares FormatCell's focus/draft-text behavior.
function PlainNumberInput({
  value, onChange, className,
}: {
  value: string | number
  onChange: (raw: string) => void
  className?: string
}) {
  const [focused, setFocused] = useState(false)
  const [draftText, setDraftText] = useState("")
  const displayValue = focused ? draftText : formatNumberForDisplay(value)
  return (
    <input
      type="text"
      inputMode="decimal"
      value={displayValue}
      onFocus={() => {
        setFocused(true)
        setDraftText(value === "" || value == null ? "" : String(value))
      }}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        const cleaned = e.target.value.replace(/[^0-9.-]/g, "")
        setDraftText(cleaned)
        onChange(cleaned)
      }}
      className={className}
    />
  )
}

function CategorySelect({
  qid, item, categoryOptions, onChange,
}: {
  qid: number
  item: DraftItem
  categoryOptions: { value: string; label: string }[]
  onChange: (qid: number, key: string, value: string | null) => void
}) {
  return (
    <select
      className="w-full bg-transparent border-0 text-[10px] text-muted-foreground focus:outline-none"
      value={item.matchedCategory ?? ""}
      onChange={(e) => onChange(qid, item.key, e.target.value || null)}
      title="Move to a different comparison line"
    >
      <option value="">— Other —</option>
      {categoryOptions.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  )
}

function CustomFieldCells({
  qid, item, customColumns, onChange, onToggleFormat,
}: {
  qid: number
  item: DraftItem
  customColumns: CustomColumn[]
  onChange: (qid: number, key: string, colId: string, value: string) => void
  onToggleFormat: FormatCellProps["onToggleFormat"]
}) {
  return (
    <>
      {customColumns.map((col) => (
        <td key={col.id}>
          <FormatCell
            qid={qid}
            item={item}
            field={col.id}
            value={item.customFields[col.id] ?? ""}
            onChange={(v) => onChange(qid, item.key, col.id, v)}
            onToggleFormat={onToggleFormat}
            placeholder="-"
          />
        </td>
      ))}
    </>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────
export function ExportPreviewModal({ open, onClose, comparison, project, projectId, basePath }: Props) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const updateQuotation = useUpdateQuotation()
  const updateProject = useUpdateProject()

  const doneVendors = useMemo(
    () => comparison.vendors.filter((v) => v.status === "done"),
    [comparison.vendors]
  )

  const [draft, setDraft] = useState<Record<number, DraftVendor>>(() => buildInitialDraft(comparison, doneVendors))
  const [dirty, setDirty] = useState<Set<number>>(new Set())
  const [saving, setSaving] = useState(false)

  // Category labels (index-aligned with comparison.rows) — editable, project-wide rename on save
  const [categories, setCategories] = useState<string[]>(() => comparison.rows.map((r) => r.category))
  // Shared column config, lives on the project
  const [customColumns, setCustomColumns] = useState<CustomColumn[]>(() => project.customColumns)
  const [columnLabels, setColumnLabels] = useState<ColumnLabels>(() => project.columnLabels)
  const [projectMetaDirty, setProjectMetaDirty] = useState(false)

  const colsPerVendor = 6 + customColumns.length

  // Shared fixed-width layout — same numbers drive the header's <colgroup> and
  // every vendor's item <table>, which is what keeps them aligned (see COL_WIDTH).
  const vendorBlockWidth = useMemo(
    () => BUILTIN_COL_KEYS.reduce((sum, k) => sum + COL_WIDTH[k], 0) + customColumns.length * CUSTOM_COL_WIDTH,
    [customColumns.length]
  )
  const tableWidth = CATEGORY_COL_WIDTH + doneVendors.length * vendorBlockWidth

  const categoryOptions = useMemo(
    () => comparison.rows.map((r, i) => ({ value: r.category, label: categories[i] ?? r.category })),
    [comparison.rows, categories]
  )

  const [hiddenVendors, setHiddenVendors] = useState<Set<number>>(new Set())
  const [hiddenRows, setHiddenRows] = useState<Set<string>>(new Set())

  const toggleVendor = (id: number) =>
    setHiddenVendors((prev) => {
      const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next
    })

  const toggleRow = (category: string) =>
    setHiddenRows((prev) => {
      const next = new Set(prev); next.has(category) ? next.delete(category) : next.add(category); return next
    })

  const resetAll = () => { setHiddenVendors(new Set()); setHiddenRows(new Set()) }

  const markDirty = (qid: number) => setDirty((prev) => new Set(prev).add(qid))

  const getLabel = (key: keyof ColumnLabels) => columnLabels[key] || DEFAULT_COL_LABELS[key]

  const updateColumnLabel = (key: keyof ColumnLabels, value: string) => {
    setColumnLabels((prev) => ({ ...prev, [key]: value }))
    setProjectMetaDirty(true)
  }

  const updateCategoryLabel = (idx: number, value: string) => {
    setCategories((prev) => prev.map((c, i) => (i === idx ? value : c)))
    setProjectMetaDirty(true)
  }

  const addCustomColumn = () => {
    setCustomColumns((prev) => [...prev, { id: nextColId(), label: "New Column" }])
    setProjectMetaDirty(true)
  }

  const renameCustomColumn = (id: string, label: string) => {
    setCustomColumns((prev) => prev.map((c) => (c.id === id ? { ...c, label } : c)))
    setProjectMetaDirty(true)
  }

  const removeCustomColumn = (id: string) => {
    setCustomColumns((prev) => prev.filter((c) => c.id !== id))
    setProjectMetaDirty(true)
  }

  const updateVendorField = (qid: number, field: "vendorName" | "vendorAddress" | "vendorContact", value: string) => {
    setDraft((prev) => ({ ...prev, [qid]: { ...prev[qid], [field]: value === "" ? (field === "vendorName" ? prev[qid].vendorName : null) : value } }))
    markDirty(qid)
  }

  const updateItemField = <K extends keyof DraftItem>(qid: number, key: string, field: K, value: DraftItem[K]) => {
    setDraft((prev) => {
      const vendor = prev[qid]
      const items = vendor.items.map((it) => {
        if (it.key !== key) return it
        const updated = { ...it, [field]: value }
        // Disc % is applied against MRP to derive Rate, which then flows into Total.
        if ((field === "discountPercent" || field === "mrp") && updated.mrp != null) {
          updated.unitPrice = Math.round(updated.mrp * (1 - (updated.discountPercent ?? 0) / 100) * 100) / 100
        }
        // Keep Total in sync with Qty × Rate so a vendor's stated total can be
        // visually compared against the correct figure instead of trusted blindly.
        // Total stays a normal editable field — typing in it directly still overrides.
        if (field === "quantity" || field === "unitPrice" || field === "discountPercent" || field === "mrp") {
          updated.totalPrice = Math.round(updated.quantity * updated.unitPrice * 100) / 100
        }
        return updated
      })
      const nextVendor = { ...vendor, items }
      return { ...prev, [qid]: { ...nextVendor, grandTotal: computeGrandTotal(nextVendor) } }
    })
    markDirty(qid)
  }

  const setItemCategory = (qid: number, key: string, value: string | null) =>
    updateItemField(qid, key, "matchedCategory", value)

  const toggleItemFormat = (qid: number, key: string, field: string, flag: keyof ItemFormatState) => {
    setDraft((prev) => ({
      ...prev,
      [qid]: {
        ...prev[qid],
        items: prev[qid].items.map((it) =>
          it.key === key
            ? { ...it, format: { ...it.format, [field]: { ...it.format[field], [flag]: !it.format[field]?.[flag] } } }
            : it
        ),
      },
    }))
    markDirty(qid)
  }

  const updateItemCustomField = (qid: number, key: string, colId: string, value: string) => {
    setDraft((prev) => ({
      ...prev,
      [qid]: {
        ...prev[qid],
        items: prev[qid].items.map((it) => (it.key === key ? { ...it, customFields: { ...it.customFields, [colId]: value } } : it)),
      },
    }))
    markDirty(qid)
  }

  const addItem = (qid: number, category: string | null) => {
    setDraft((prev) => {
      const vendor = prev[qid]
      const items = [
        ...vendor.items,
        { key: nextKey(), matchedCategory: category, vendorItemName: "New item", spec: null, quantity: 1, mrp: null, unitPrice: 0, discountPercent: null, totalPrice: 0, format: {}, customFields: {} },
      ]
      const nextVendor = { ...vendor, items }
      return { ...prev, [qid]: { ...nextVendor, grandTotal: computeGrandTotal(nextVendor) } }
    })
    markDirty(qid)
  }

  const removeItem = (qid: number, key: string) => {
    setDraft((prev) => {
      const vendor = prev[qid]
      const items = vendor.items.filter((it) => it.key !== key)
      const nextVendor = { ...vendor, items }
      return { ...prev, [qid]: { ...nextVendor, grandTotal: computeGrandTotal(nextVendor) } }
    })
    markDirty(qid)
  }

  const updateAdditionalInfo = (qid: number, field: string, value: string) => {
    setDraft((prev) => {
      const vendor = prev[qid]
      const nextVendor = { ...vendor, additionalInfo: { ...vendor.additionalInfo, [field]: value === "" ? null : value } }
      // GST/Freight/Installation feed the Grand Total (flat ₹ or a "%" of items subtotal).
      const grandTotal = (CHARGE_KEYS as readonly string[]).includes(field) ? computeGrandTotal(nextVendor) : nextVendor.grandTotal
      return { ...prev, [qid]: { ...nextVendor, grandTotal } }
    })
    markDirty(qid)
  }

  const updateGrandTotal = (qid: number, value: string) => {
    const num = value === "" ? null : Number(value)
    setDraft((prev) => ({ ...prev, [qid]: { ...prev[qid], grandTotal: num !== null && isNaN(num) ? prev[qid].grandTotal : num } }))
    markDirty(qid)
  }

  const handleSave = useCallback(async (): Promise<boolean> => {
    // Figure out category renames (index-aligned with comparison.rows) and validate.
    const renameMap: Record<string, string> = {}
    const finalCategories = categories.map((c) => c.trim())
    for (let i = 0; i < comparison.rows.length; i++) {
      const original = comparison.rows[i].category
      const next = finalCategories[i]
      if (!next) {
        toast({ title: "Category name can't be empty", variant: "destructive" })
        return false
      }
      if (next !== original) renameMap[original] = next
    }
    const lowerSeen = new Set<string>()
    for (const c of finalCategories) {
      const lower = c.toLowerCase()
      if (lowerSeen.has(lower)) {
        toast({ title: `Duplicate category name "${c}"`, description: "To merge items, use the category dropdown on each item instead of renaming two categories to the same thing.", variant: "destructive" })
        return false
      }
      lowerSeen.add(lower)
    }

    const hasRenames = Object.keys(renameMap).length > 0
    const finalCustomColumns = customColumns.map((c) => ({ id: c.id, label: c.label.trim() || "Column" }))
    const finalColumnLabels: ColumnLabels = {}
    for (const k of BUILTIN_COL_KEYS) {
      const v = (columnLabels[k] ?? "").trim()
      if (v) finalColumnLabels[k] = v
    }
    const projectChanged = hasRenames || projectMetaDirty

    const vendorIdsToSave = new Set(dirty)
    if (hasRenames) {
      for (const v of doneVendors) vendorIdsToSave.add(v.id)
    }

    if (vendorIdsToSave.size === 0 && !projectChanged) return true

    setSaving(true)
    try {
      await Promise.all([
        ...[...vendorIdsToSave].map((qid) => {
          const v = draft[qid]
          const items = v.items.map(({ key, format, customFields, matchedCategory, ...rest }) => {
            const cleanedFormat = Object.fromEntries(
              Object.entries(format).filter(([, f]) => f && Object.values(f).some(Boolean))
            )
            return {
              ...rest,
              matchedCategory: matchedCategory && renameMap[matchedCategory] ? renameMap[matchedCategory] : matchedCategory,
              format: Object.keys(cleanedFormat).length > 0 ? cleanedFormat : undefined,
              customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
            }
          })
          return updateQuotation.mutateAsync({
            id: projectId,
            qid,
            data: {
              vendorName: v.vendorName,
              vendorAddress: v.vendorAddress,
              vendorContact: v.vendorContact,
              items,
              additionalInfo: v.additionalInfo as any,
              grandTotal: v.grandTotal,
            },
          })
        }),
        ...(projectChanged
          ? [updateProject.mutateAsync({ id: projectId, data: { targetItems: finalCategories, customColumns: finalCustomColumns, columnLabels: finalColumnLabels } })]
          : []),
      ])
      // The invalidations below refetch `comparison` in the background — since this modal
      // stays mounted, its `comparison` prop will update to the server's new category names
      // once that resolves. Remap local items to match now, so they don't fall out of sync
      // and get miscategorized as "Other" the moment the fresh prop arrives.
      if (hasRenames) {
        setDraft((prev) => {
          const next: typeof prev = {}
          for (const [qidStr, v] of Object.entries(prev)) {
            next[Number(qidStr)] = {
              ...v,
              items: v.items.map((it) => ({
                ...it,
                matchedCategory: it.matchedCategory && renameMap[it.matchedCategory] ? renameMap[it.matchedCategory] : it.matchedCategory,
              })),
            }
          }
          return next
        })
      }
      queryClient.invalidateQueries({ queryKey: getGetComparisonQueryKey(projectId) })
      queryClient.invalidateQueries({ queryKey: getListQuotationsQueryKey(projectId) })
      queryClient.invalidateQueries({ queryKey: getGetProjectSummaryQueryKey(projectId) })
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) })
      setDirty(new Set())
      setProjectMetaDirty(false)
      toast({ title: "Changes saved" })
      return true
    } catch {
      toast({ title: "Failed to save changes", variant: "destructive" })
      return false
    } finally {
      setSaving(false)
    }
  }, [dirty, draft, projectId, queryClient, toast, updateQuotation, updateProject, categories, comparison.rows, customColumns, columnLabels, projectMetaDirty, doneVendors])

  const visibleOtherItems = comparison.otherItems.filter((item) => !hiddenVendors.has(item.quotationId))

  const handleExport = async () => {
    if (dirty.size > 0 || projectMetaDirty) {
      const ok = await handleSave()
      if (!ok) return
    }
    const params = new URLSearchParams()
    if (hiddenVendors.size) params.set("excludeVendors", [...hiddenVendors].join(","))
    if (hiddenRows.size) params.set("excludeRows", [...hiddenRows].join(";;"))
    const qs = params.toString() ? `?${params.toString()}` : ""
    window.location.href = `${basePath}api/projects/${projectId}/export${qs}`
  }

  // Close on Escape
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose()
  }, [onClose])
  useEffect(() => {
    if (!open) return
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [open, handleKeyDown])

  const removedCount = hiddenVendors.size + hiddenRows.size
  const hasUnsaved = dirty.size > 0 || projectMetaDirty

  if (!open) return null

  const ColGroup = () => (
    <colgroup>
      <col style={{ width: CATEGORY_COL_WIDTH }} />
      {doneVendors.map((v) => (
        <React.Fragment key={v.id}>
          {BUILTIN_COL_KEYS.map((k) => <col key={k} style={{ width: COL_WIDTH[k] }} />)}
          {customColumns.map((col) => <col key={col.id} style={{ width: CUSTOM_COL_WIDTH }} />)}
        </React.Fragment>
      ))}
    </colgroup>
  )

  const VendorColGroup = () => (
    <colgroup>
      {BUILTIN_COL_KEYS.map((k) => <col key={k} style={{ width: COL_WIDTH[k] }} />)}
      {customColumns.map((col) => <col key={col.id} style={{ width: CUSTOM_COL_WIDTH }} />)}
    </colgroup>
  )

  return createPortal(
    /* Backdrop */
    <div
      className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      {/* Panel */}
      <div
        className="bg-background rounded-lg shadow-2xl border flex flex-col"
        style={{ width: "97vw", maxWidth: 1600, height: "92vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-3 border-b shrink-0">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Edit &amp; Export</h2>
            <div className="flex items-center gap-2">
              {hasUnsaved && (
                <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 text-xs">
                  Unsaved changes
                </Badge>
              )}
              <Button variant="ghost" size="sm" onClick={addCustomColumn} className="h-8 text-xs gap-1.5">
                <Columns3 className="w-3.5 h-3.5" />
                Add Column
              </Button>
              {removedCount > 0 && (
                <Button variant="ghost" size="sm" onClick={resetAll} className="h-8 text-xs gap-1.5">
                  <RotateCcw className="w-3.5 h-3.5" />
                  Reset exclusions ({removedCount})
                </Button>
              )}
              <button onClick={onClose} className="rounded p-1 hover:bg-muted transition-colors text-muted-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Click any cell to edit it, add columns, or hover a cell to reveal B/I/U/highlight for just that column. Use the category dropdown under an item to merge it into a different comparison line.
          </p>
        </div>

        {/* Scrollable table area */}
        <div className="flex-1 overflow-auto min-h-0">
          <table className="text-sm border-collapse" style={{ width: tableWidth, tableLayout: "fixed" }}>
            <ColGroup />
            <thead className="sticky top-0 z-20">
              {/* Vendor header row — editable name/address/contact */}
              <tr>
                <th className="sticky left-0 z-30 bg-[#1F4E79] text-white text-left px-3 py-2 font-semibold border border-white/20 align-bottom">
                  Category
                </th>
                {doneVendors.map((v) => {
                  const hidden = hiddenVendors.has(v.id)
                  const dv = draft[v.id]
                  return (
                    <th
                      key={v.id}
                      colSpan={colsPerVendor}
                      className={`border border-white/20 text-left px-3 py-2 transition-all align-top ${
                        hidden ? "bg-muted/40 text-muted-foreground" : "bg-[#1F4E79] text-white"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <input
                            value={dv.vendorName}
                            onChange={(e) => updateVendorField(v.id, "vendorName", e.target.value)}
                            className={`w-full bg-transparent border-0 border-b border-dashed font-semibold text-sm leading-tight focus:outline-none px-0 ${hidden ? "line-through border-transparent" : "border-white/30 focus:border-white placeholder:text-white/50"}`}
                            placeholder="Vendor name"
                          />
                          <input
                            value={dv.vendorAddress ?? ""}
                            onChange={(e) => updateVendorField(v.id, "vendorAddress", e.target.value)}
                            className="w-full bg-transparent border-0 text-[10px] opacity-80 font-normal focus:outline-none px-0 placeholder:text-white/40"
                            placeholder="Address"
                          />
                          <input
                            value={dv.vendorContact ?? ""}
                            onChange={(e) => updateVendorField(v.id, "vendorContact", e.target.value)}
                            className="w-full bg-transparent border-0 text-[10px] opacity-80 font-normal focus:outline-none px-0 placeholder:text-white/40"
                            placeholder="Contact"
                          />
                          {dv.isBenchmark && (
                            <div className="text-[10px] font-bold uppercase mt-0.5 text-yellow-300">Benchmark</div>
                          )}
                        </div>
                        <button
                          onClick={() => toggleVendor(v.id)}
                          title={hidden ? "Include column in export" : "Exclude column from export"}
                          className={`shrink-0 rounded p-0.5 transition-colors mt-0.5 ${
                            hidden
                              ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                              : "bg-white/10 text-white/80 hover:bg-red-500/80 hover:text-white"
                          }`}
                        >
                          {hidden ? <Eye className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    </th>
                  )
                })}
              </tr>
              {/* Sub-header row — editable labels, shared across all vendor blocks */}
              <tr>
                <th className="sticky left-0 z-30 bg-[#2E75B6] text-white text-left px-3 py-1.5 font-medium text-xs border border-white/20"></th>
                {doneVendors.map((v) => {
                  const hidden = hiddenVendors.has(v.id)
                  return (
                    <React.Fragment key={v.id}>
                      {BUILTIN_COL_KEYS.map((k) => (
                        <th
                          key={k}
                          className={`px-1 py-1.5 text-right border border-white/20 transition-all ${
                            hidden ? "bg-muted/30 text-muted-foreground" : "bg-[#2E75B6] text-white"
                          }`}
                        >
                          <input
                            value={getLabel(k)}
                            onChange={(e) => updateColumnLabel(k, e.target.value)}
                            className="w-full bg-transparent border-0 text-right text-xs font-medium focus:outline-none placeholder:text-white/50"
                          />
                        </th>
                      ))}
                      {customColumns.map((col) => (
                        <th
                          key={col.id}
                          className={`px-1 py-1.5 text-right border border-white/20 transition-all ${
                            hidden ? "bg-muted/30 text-muted-foreground" : "bg-[#2E75B6] text-white"
                          }`}
                        >
                          <div className="flex items-center gap-1">
                            <input
                              value={col.label}
                              onChange={(e) => renameCustomColumn(col.id, e.target.value)}
                              className="w-full bg-transparent border-0 text-right text-xs font-medium focus:outline-none"
                            />
                            <button onClick={() => removeCustomColumn(col.id)} title="Remove column" className="shrink-0 opacity-60 hover:opacity-100">
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        </th>
                      ))}
                    </React.Fragment>
                  )
                })}
              </tr>
            </thead>

            <tbody>
              {comparison.rows.map((row, rIdx) => {
                const key = row.category
                const hidden = hiddenRows.has(key)

                return (
                  <tr key={key} className={`border-b align-top transition-all ${hidden ? "opacity-40 bg-muted/20" : ""}`}>
                    {/* Category cell — editable label (project-wide rename on save) */}
                    <td className="sticky left-0 bg-background z-10 border-r px-3 py-2 font-medium">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => toggleRow(key)}
                          title={hidden ? "Restore row" : "Remove row from export"}
                          className={`shrink-0 rounded p-0.5 transition-colors ${
                            hidden
                              ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                              : "bg-muted text-muted-foreground hover:bg-red-100 hover:text-red-600"
                          }`}
                        >
                          {hidden ? <Eye className="w-3 h-3" /> : <X className="w-3 h-3" />}
                        </button>
                        <input
                          value={categories[rIdx] ?? row.category}
                          onChange={(e) => updateCategoryLabel(rIdx, e.target.value)}
                          className={`min-w-0 flex-1 bg-transparent border-0 border-b border-dashed border-transparent hover:border-muted-foreground/40 focus:border-primary focus:outline-none text-sm px-0 ${hidden ? "line-through" : ""}`}
                          title="Rename this category (applies project-wide on save)"
                        />
                      </div>
                    </td>

                    {doneVendors.map((v) => {
                      const dv = draft[v.id]
                      const vHidden = hiddenVendors.has(v.id)
                      const items = dv.items.filter((it) => it.matchedCategory === row.category)
                      const subtotal = items.reduce((sum, it) => sum + (it.totalPrice || 0), 0)

                      return (
                        <td key={v.id} colSpan={colsPerVendor} className={`border-l p-0 align-top ${vHidden ? "opacity-30" : ""}`}>
                          <table style={{ width: vendorBlockWidth, tableLayout: "fixed" }}>
                            <VendorColGroup />
                            <tbody>
                              {items.map((it) => (
                                <tr key={it.key} className="border-b border-border/40 last:border-b-0 group/item">
                                  <td>
                                    <FormatCell qid={v.id} item={it} field="vendorItemName" value={it.vendorItemName} onChange={(v2) => updateItemField(v.id, it.key, "vendorItemName", v2)} onToggleFormat={toggleItemFormat} placeholder="Item name" />
                                    <FormatCell qid={v.id} item={it} field="spec" value={it.spec ?? ""} onChange={(v2) => updateItemField(v.id, it.key, "spec", v2 || null)} onToggleFormat={toggleItemFormat} placeholder="Spec" inputClassName="text-muted-foreground" />
                                    <CategorySelect qid={v.id} item={it} categoryOptions={categoryOptions} onChange={setItemCategory} />
                                  </td>
                                  <td><FormatCell qid={v.id} item={it} field="quantity" type="number" value={it.quantity} onChange={(v2) => updateItemField(v.id, it.key, "quantity", Number(v2))} onToggleFormat={toggleItemFormat} /></td>
                                  <td><FormatCell qid={v.id} item={it} field="mrp" type="number" value={it.mrp ?? ""} onChange={(v2) => updateItemField(v.id, it.key, "mrp", v2 === "" ? null : Number(v2))} onToggleFormat={toggleItemFormat} /></td>
                                  <td><FormatCell qid={v.id} item={it} field="unitPrice" type="number" value={it.unitPrice} onChange={(v2) => updateItemField(v.id, it.key, "unitPrice", Number(v2))} onToggleFormat={toggleItemFormat} /></td>
                                  <td><FormatCell qid={v.id} item={it} field="discountPercent" type="number" value={it.discountPercent ?? ""} onChange={(v2) => updateItemField(v.id, it.key, "discountPercent", v2 === "" ? null : Number(v2))} onToggleFormat={toggleItemFormat} /></td>
                                  <td>
                                    <div className="flex items-start">
                                      <div className="flex-1 min-w-0">
                                        <FormatCell qid={v.id} item={it} field="totalPrice" type="number" value={it.totalPrice} onChange={(v2) => updateItemField(v.id, it.key, "totalPrice", Number(v2))} onToggleFormat={toggleItemFormat} inputClassName="font-medium" />
                                      </div>
                                      <button onClick={() => removeItem(v.id, it.key)} className="opacity-0 group-hover/item:opacity-100 text-muted-foreground hover:text-destructive shrink-0 pr-1 mt-0.5" title="Delete item">
                                        <Trash2 className="w-3 h-3" />
                                      </button>
                                    </div>
                                  </td>
                                  <CustomFieldCells qid={v.id} item={it} customColumns={customColumns} onChange={updateItemCustomField} onToggleFormat={toggleItemFormat} />
                                </tr>
                              ))}
                              <tr>
                                <td colSpan={5 + customColumns.length} className="px-1 py-1">
                                  <button onClick={() => addItem(v.id, row.category)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary">
                                    <Plus className="w-3 h-3" /> Add item
                                  </button>
                                </td>
                                <td className="px-1 py-1 text-right text-xs font-semibold tabular-nums pr-2">
                                  {items.length > 0 ? fmt(subtotal) : ""}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}

              {/* Other items offered */}
              <tr className="border-b-2 align-top bg-muted/5">
                <td className="sticky left-0 bg-muted/5 z-10 border-r px-3 py-2 font-medium text-xs italic text-muted-foreground">
                  Other Items Offered
                </td>
                {doneVendors.map((v) => {
                  const dv = draft[v.id]
                  const vHidden = hiddenVendors.has(v.id)
                  const items = dv.items.filter((it) => it.matchedCategory === null || !comparison.rows.some((r) => r.category === it.matchedCategory))

                  return (
                    <td key={v.id} colSpan={colsPerVendor} className={`border-l p-0 align-top ${vHidden ? "opacity-30" : ""}`}>
                      <table style={{ width: vendorBlockWidth, tableLayout: "fixed" }}>
                        <VendorColGroup />
                        <tbody>
                          {items.map((it) => (
                            <tr key={it.key} className="border-b border-border/40 last:border-b-0 group/item">
                              <td>
                                <FormatCell qid={v.id} item={it} field="vendorItemName" value={it.vendorItemName} onChange={(v2) => updateItemField(v.id, it.key, "vendorItemName", v2)} onToggleFormat={toggleItemFormat} placeholder="Item name" />
                                <FormatCell qid={v.id} item={it} field="spec" value={it.spec ?? ""} onChange={(v2) => updateItemField(v.id, it.key, "spec", v2 || null)} onToggleFormat={toggleItemFormat} placeholder="Spec" inputClassName="text-muted-foreground" />
                                <CategorySelect qid={v.id} item={it} categoryOptions={categoryOptions} onChange={setItemCategory} />
                              </td>
                              <td><FormatCell qid={v.id} item={it} field="quantity" type="number" value={it.quantity} onChange={(v2) => updateItemField(v.id, it.key, "quantity", Number(v2))} onToggleFormat={toggleItemFormat} /></td>
                              <td><FormatCell qid={v.id} item={it} field="mrp" type="number" value={it.mrp ?? ""} onChange={(v2) => updateItemField(v.id, it.key, "mrp", v2 === "" ? null : Number(v2))} onToggleFormat={toggleItemFormat} /></td>
                              <td><FormatCell qid={v.id} item={it} field="unitPrice" type="number" value={it.unitPrice} onChange={(v2) => updateItemField(v.id, it.key, "unitPrice", Number(v2))} onToggleFormat={toggleItemFormat} /></td>
                              <td><FormatCell qid={v.id} item={it} field="discountPercent" type="number" value={it.discountPercent ?? ""} onChange={(v2) => updateItemField(v.id, it.key, "discountPercent", v2 === "" ? null : Number(v2))} onToggleFormat={toggleItemFormat} /></td>
                              <td>
                                <div className="flex items-start">
                                  <div className="flex-1 min-w-0">
                                    <FormatCell qid={v.id} item={it} field="totalPrice" type="number" value={it.totalPrice} onChange={(v2) => updateItemField(v.id, it.key, "totalPrice", Number(v2))} onToggleFormat={toggleItemFormat} inputClassName="font-medium" />
                                  </div>
                                  <button onClick={() => removeItem(v.id, it.key)} className="opacity-0 group-hover/item:opacity-100 text-muted-foreground hover:text-destructive shrink-0 pr-1 mt-0.5" title="Delete item">
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </div>
                              </td>
                              <CustomFieldCells qid={v.id} item={it} customColumns={customColumns} onChange={updateItemCustomField} onToggleFormat={toggleItemFormat} />
                            </tr>
                          ))}
                          <tr>
                            <td colSpan={6 + customColumns.length} className="px-1 py-1">
                              <button onClick={() => addItem(v.id, null)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary">
                                <Plus className="w-3 h-3" /> Add item
                              </button>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </td>
                  )
                })}
              </tr>

              {/* Additional info rows */}
              <tr><td colSpan={1 + doneVendors.length * colsPerVendor} className="h-3 p-0"></td></tr>
              {ADDITIONAL_INFO_KEYS.map((infoKey) => (
                <tr key={infoKey} className="bg-muted/5 text-xs">
                  <td className="sticky left-0 bg-muted/5 z-10 border-r px-3 py-1.5 font-medium text-muted-foreground italic">
                    {ADDITIONAL_INFO_LABELS[infoKey]}
                    {(CHARGE_KEYS as readonly string[]).includes(infoKey) && (
                      <span className="not-italic normal-case text-[9px] text-muted-foreground/60"> (in Grand Total)</span>
                    )}
                  </td>
                  {doneVendors.map((v) => {
                    const dv = draft[v.id]
                    const vHidden = hiddenVendors.has(v.id)
                    return (
                      <td key={v.id} colSpan={colsPerVendor} className={`px-3 py-1.5 border-l transition-all ${vHidden ? "opacity-30" : ""}`}>
                        <input
                          className="w-full bg-transparent border-0 border-b border-dashed border-transparent hover:border-muted-foreground/40 focus:border-primary focus:outline-none text-muted-foreground text-xs px-0 py-0.5"
                          value={dv.additionalInfo[infoKey] ?? ""}
                          onChange={(e) => updateAdditionalInfo(v.id, infoKey, e.target.value)}
                          placeholder={(CHARGE_KEYS as readonly string[]).includes(infoKey) ? "e.g. 18% or ₹2000" : "-"}
                        />
                      </td>
                    )
                  })}
                </tr>
              ))}

              {/* Grand total row */}
              <tr className="font-bold bg-[#1F4E79] text-white border-t-2">
                <td className="sticky left-0 bg-[#1F4E79] z-10 border-r px-3 py-2.5 text-sm">
                  GRAND TOTAL
                </td>
                {doneVendors.map((v) => {
                  const dv = draft[v.id]
                  const vHidden = hiddenVendors.has(v.id)
                  return (
                    <td key={v.id} colSpan={colsPerVendor} className={`border-l px-2 py-2.5 ${vHidden ? "opacity-30" : ""}`}>
                      <PlainNumberInput
                        value={dv.grandTotal ?? ""}
                        onChange={(raw) => updateGrandTotal(v.id, raw)}
                        className="w-full bg-transparent border-0 border-b border-dashed border-white/30 focus:border-white focus:outline-none text-right tabular-nums text-sm px-1"
                      />
                    </td>
                  )
                })}
              </tr>
            </tbody>
          </table>

          {!doneVendors.length && (
            <div className="p-8 text-center text-sm text-muted-foreground">No parsed quotations to edit yet.</div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t shrink-0 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {removedCount > 0 ? (
              <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50">
                {hiddenVendors.size > 0 && `${hiddenVendors.size} vendor${hiddenVendors.size > 1 ? "s" : ""}`}
                {hiddenVendors.size > 0 && hiddenRows.size > 0 && " · "}
                {hiddenRows.size > 0 && `${hiddenRows.size} row${hiddenRows.size > 1 ? "s" : ""}`}
                {" "}excluded from export
              </Badge>
            ) : (
              <span className="text-xs">All rows &amp; columns included</span>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Close</Button>
            <Button variant="outline" onClick={() => handleSave()} disabled={saving || !hasUnsaved} className="gap-2">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Changes
            </Button>
            <Button onClick={handleExport} disabled={saving} className="gap-2">
              <Download className="w-4 h-4" />
              Download Excel
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
