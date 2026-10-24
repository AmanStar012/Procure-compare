import React, { useState, useRef, useMemo, ChangeEvent } from "react"
import { useParams, useLocation } from "wouter"
import { useQueryClient } from "@tanstack/react-query"
import { 
  useGetProject, 
  useGetProjectSummary, 
  useGetComparison, 
  useListQuotations,
  useDeleteQuotation,
  useSetBenchmark,
  getGetProjectQueryKey,
  getGetProjectSummaryQueryKey,
  getGetComparisonQueryKey,
  getListQuotationsQueryKey
} from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow,
  TableFooter
} from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"
import { 
  Loader2, 
  UploadCloud, 
  FileText, 
  Trash2, 
  CheckCircle2, 
  AlertCircle,
  Download,
  Star,
  MoreVertical,
  Activity,
  ChevronRight,
  ChevronDown
} from "lucide-react"
import { ExportPreviewModal } from "@/components/ExportPreviewModal"
import { computeCharges, CHARGE_KEYS, CHARGE_LABELS, type ChargeBreakdown } from "@/lib/charges"

// Currency formatter
const formatCurrency = (amount: number | null | undefined) => {
  if (amount === null || amount === undefined) return "-"
  return '₹ ' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(amount)
}

// The monetary rows are calculated (see computeCharges), so they're left out of the plain-text terms rows.
const CHARGE_LABEL_SET = new Set<string>(Object.values(CHARGE_LABELS))

export function ProjectDetail() {
  const params = useParams()
  const projectId = Number(params.id)
  const { toast } = useToast()
  const queryClient = useQueryClient()
  
  const [isUploading, setIsUploading] = useState(false)
  const [showExportPreview, setShowExportPreview] = useState(false)
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set())
  const fileInputRef = useRef<HTMLInputElement>(null)

  const toggleRowExpanded = (rIdx: number) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(rIdx)) next.delete(rIdx)
      else next.add(rIdx)
      return next
    })
  }

  const { data: project, isLoading: loadingProject } = useGetProject(projectId, {
    query: { queryKey: getGetProjectQueryKey(projectId), enabled: !!projectId }
  })

  const { data: summary, isLoading: loadingSummary } = useGetProjectSummary(projectId, {
    query: { queryKey: getGetProjectSummaryQueryKey(projectId), enabled: !!projectId }
  })

  const { data: quotations = [], isLoading: loadingQuotations } = useListQuotations(projectId, {
    query: { queryKey: getListQuotationsQueryKey(projectId), enabled: !!projectId }
  })

  // Only load comparison if we have parsed quotations
  const hasParsedQuotations = quotations.some(q => q.status === 'done')
  const { data: comparison, isLoading: loadingComparison } = useGetComparison(projectId, {
    query: { queryKey: getGetComparisonQueryKey(projectId), enabled: !!projectId && hasParsedQuotations }
  })

  // Our own calculation of each vendor's subtotal, charges, GST and grand total — vendors make
  // arithmetic mistakes, so the total printed on their document is only kept as a cross-check.
  const vendorCharges = useMemo(() => {
    const m = new Map<number, ChargeBreakdown>()
    if (!comparison) return m
    for (const vd of comparison.vendorDetails ?? []) {
      const id = vd.quotationId
      const items = [
        ...comparison.rows.flatMap((r) => r.vendors.find((v) => v.quotationId === id)?.lineItems ?? []),
        ...comparison.otherItems.filter((o) => o.quotationId === id),
      ]
      const info: Partial<Record<"gst" | (typeof CHARGE_KEYS)[number], string | null>> = {}
      for (const key of [...CHARGE_KEYS, "gst" as const]) {
        const row = comparison.additionalInfo.find((a) => a.label === CHARGE_LABELS[key])
        info[key] = row?.vendors.find((iv) => iv.quotationId === id)?.value ?? null
      }
      m.set(id, computeCharges(items, info))
    }
    return m
  }, [comparison])

  const deleteQuotation = useDeleteQuotation()
  const setBenchmark = useSetBenchmark()

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setIsUploading(true)
    const formData = new FormData()
    formData.append("file", file)

    try {
      const response = await fetch(`${import.meta.env.BASE_URL}api/projects/${projectId}/quotations/upload`, {
        method: "POST",
        body: formData
      })
      
      if (!response.ok) throw new Error("Upload failed")
      
      toast({ title: "Quotation uploaded successfully", description: "Parsing has started." })
      
      // Invalidate queries to refresh data
      queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) })
      queryClient.invalidateQueries({ queryKey: getGetProjectSummaryQueryKey(projectId) })
      queryClient.invalidateQueries({ queryKey: getListQuotationsQueryKey(projectId) })
      
      // Since parsing might take time, we might want to poll, but for now we just refetch once
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: getListQuotationsQueryKey(projectId) })
        queryClient.invalidateQueries({ queryKey: getGetComparisonQueryKey(projectId) })
      }, 3000)
      
    } catch (err) {
      toast({ title: "Upload failed", variant: "destructive" })
    } finally {
      setIsUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const handleDeleteQuotation = (qid: number) => {
    deleteQuotation.mutate({ id: projectId, qid }, {
      onSuccess: () => {
        toast({ title: "Quotation deleted" })
        queryClient.invalidateQueries({ queryKey: getListQuotationsQueryKey(projectId) })
        queryClient.invalidateQueries({ queryKey: getGetComparisonQueryKey(projectId) })
        queryClient.invalidateQueries({ queryKey: getGetProjectSummaryQueryKey(projectId) })
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) })
      }
    })
  }

  const handleSetBenchmark = (qid: number) => {
    setBenchmark.mutate({ id: projectId, qid }, {
      onSuccess: () => {
        toast({ title: "Benchmark updated" })
        queryClient.invalidateQueries({ queryKey: getListQuotationsQueryKey(projectId) })
        queryClient.invalidateQueries({ queryKey: getGetComparisonQueryKey(projectId) })
        queryClient.invalidateQueries({ queryKey: getGetProjectSummaryQueryKey(projectId) })
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) })
      }
    })
  }

  const handleExport = () => setShowExportPreview(true)

  if (loadingProject) {
    return <div className="flex justify-center p-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
  }

  if (!project) return <div>Project not found</div>

  // One vendor-wide row of the charges block: a note across Spec..Disc and the amount under Total.
  const renderChargeCells = (
    rowKey: string,
    cellFor: (b: ChargeBreakdown) => { note: React.ReactNode; amount: React.ReactNode; amountClass?: string },
  ) =>
    (comparison?.vendors ?? []).map((v) => {
      const b = vendorCharges.get(v.id)
      if (!b) {
        return <TableCell key={`${rowKey}-${v.id}`} colSpan={6} className="border-l text-center text-muted-foreground/40">-</TableCell>
      }
      const c = cellFor(b)
      return (
        <React.Fragment key={`${rowKey}-${v.id}`}>
          <TableCell colSpan={5} className="border-l text-xs text-muted-foreground px-4 whitespace-normal">{c.note}</TableCell>
          <TableCell className={`text-right tabular-nums pr-4 ${c.amountClass ?? ""}`}>{c.amount}</TableCell>
        </React.Fragment>
      )
    })

  return (
    <div className="space-y-6 pb-20 animate-in fade-in duration-300">
      {/* Header & Stats */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
          {project.description && <p className="text-muted-foreground mt-1">{project.description}</p>}
          <div className="flex flex-wrap gap-1 mt-2">
            {project.targetItems.map((item) => (
              <Badge key={item} variant="outline" className="font-normal">{item}</Badge>
            ))}
          </div>
        </div>
        
        {comparison && (
          <Button onClick={handleExport} variant="outline" className="shrink-0 bg-white">
            <Download className="w-4 h-4 mr-2" />
            Export to Excel
          </Button>
        )}
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="bg-card">
            <CardContent className="p-4 flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Vendors</span>
              <span className="text-2xl font-semibold">{summary.vendorCount}</span>
            </CardContent>
          </Card>
          <Card className="bg-card">
            <CardContent className="p-4 flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Line Items</span>
              <span className="text-2xl font-semibold">{summary.itemCount}</span>
            </CardContent>
          </Card>
          <Card className="bg-emerald-50 border-emerald-200 dark:bg-emerald-950/20 dark:border-emerald-900/50">
            <CardContent className="p-4 flex flex-col gap-1">
              <span className="text-xs font-medium text-emerald-800 dark:text-emerald-400 uppercase tracking-wider">Lowest Total</span>
              <span className="text-2xl font-semibold text-emerald-900 dark:text-emerald-300">
                {formatCurrency(summary.lowestTotal)}
              </span>
              <span className="text-xs font-medium text-emerald-700/80 truncate">
                {summary.lowestVendor || 'N/A'}
              </span>
            </CardContent>
          </Card>
          <Card className="bg-amber-50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-900/50">
            <CardContent className="p-4 flex flex-col gap-1">
              <span className="text-xs font-medium text-amber-800 dark:text-amber-400 uppercase tracking-wider">Highest Total</span>
              <span className="text-2xl font-semibold text-amber-900 dark:text-amber-300">
                {formatCurrency(summary.highestTotal)}
              </span>
              <span className="text-xs font-medium text-amber-700/80 truncate">
                {summary.highestVendor || 'N/A'}
              </span>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Quotation Manager */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-4 border-b">
          <CardTitle className="text-lg">Quotations</CardTitle>
          <div>
            <input 
              type="file" 
              ref={fileInputRef} 
              className="hidden" 
              onChange={handleFileUpload}
              accept=".pdf,.xlsx,.xls,.docx,.jpg,.png"
            />
            <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={isUploading}>
              {isUploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <UploadCloud className="w-4 h-4 mr-2" />}
              Upload File
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {quotations.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground bg-muted/10">
              <FileText className="w-10 h-10 mb-4 opacity-50" />
              <p className="font-medium">No quotations uploaded</p>
              <p className="text-sm mt-1 mb-4">Upload vendor quotes to begin comparison.</p>
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                Upload First File
              </Button>
            </div>
          ) : (
            <div className="divide-y">
              {quotations.map(q => (
                <div key={q.id} className="flex items-center justify-between p-4 hover:bg-muted/30 transition-colors group">
                  <div className="flex items-start gap-3">
                    <div className="bg-primary/10 p-2 rounded text-primary mt-0.5">
                      <FileText className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{q.vendorName || 'Unknown Vendor'}</span>
                        {q.isBenchmark && (
                          <Badge variant="default" className="text-[10px] h-5 px-1.5 flex items-center gap-1">
                            <Star className="w-3 h-3 fill-current" /> Benchmark
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 font-mono">{q.fileName}</div>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-4">
                    <div className="w-24 flex justify-end">
                      {q.status === 'pending' || q.status === 'parsing' ? (
                        <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50">
                          <Activity className="w-3 h-3 mr-1 animate-pulse" />
                          Parsing...
                        </Badge>
                      ) : q.status === 'error' ? (
                        <Badge variant="destructive" className="bg-destructive/10 text-destructive border-transparent">
                          <AlertCircle className="w-3 h-3 mr-1" />
                          Error
                        </Badge>
                      ) : (
                        <Badge variant="success" className="bg-emerald-50 text-emerald-700 border-emerald-200">
                          <CheckCircle2 className="w-3 h-3 mr-1" />
                          Parsed
                        </Badge>
                      )}
                    </div>
                    
                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      {!q.isBenchmark && q.status === 'done' && (
                        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => handleSetBenchmark(q.id)} disabled={setBenchmark.isPending}>
                          Set Benchmark
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:bg-destructive/10" onClick={() => handleDeleteQuotation(q.id)} disabled={deleteQuotation.isPending}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Comparison Table */}
      {comparison && comparison.rows.length > 0 && (
        <Card className="overflow-hidden border-2">
          <div className="overflow-x-auto">
            <Table className="whitespace-nowrap">
              <TableHeader className="bg-muted/50">
                {/* Vendor name row */}
                <TableRow>
                  <TableHead className="w-[300px] sticky left-0 bg-muted/95 backdrop-blur z-20 border-r shadow-[1px_0_0_0_var(--border)]">Item / Description</TableHead>
                  {(comparison.vendorDetails ?? comparison.vendors.map((v: any) => ({ quotationId: v.id, vendorName: v.vendorName, isBenchmark: v.isBenchmark, vendorAddress: null, vendorContact: null }))).map((vd: any) => (
                    <TableHead key={vd.quotationId} className="text-center border-l bg-muted/30 align-top py-3" colSpan={6}>
                      <div className="font-semibold text-foreground text-sm">{vd.vendorName}</div>
                      {vd.vendorAddress && (
                        <div className="text-[10px] text-muted-foreground font-normal mt-0.5 max-w-[240px] mx-auto whitespace-normal leading-tight">
                          {vd.vendorAddress}
                        </div>
                      )}
                      {vd.vendorContact && (
                        <div className="text-[10px] text-muted-foreground font-normal mt-0.5">
                          {vd.vendorContact}
                        </div>
                      )}
                      {vd.isBenchmark && <div className="text-[10px] text-primary font-bold uppercase mt-1">Benchmark</div>}
                    </TableHead>
                  ))}
                </TableRow>
                {/* Sub-header: Spec | Qty | MRP | Rate | Disc % | Total per vendor */}
                <TableRow className="border-b-2">
                  <TableHead className="sticky left-0 bg-muted/95 backdrop-blur z-20 border-r shadow-[1px_0_0_0_var(--border)]"></TableHead>
                  {comparison.vendors.map((v: any) => (
                    <React.Fragment key={v.id}>
                      <TableHead className="border-l text-xs w-24">Spec</TableHead>
                      <TableHead className="text-right text-xs w-14">Qty</TableHead>
                      <TableHead className="text-right text-xs w-24">MRP</TableHead>
                      <TableHead className="text-right text-xs w-28">Rate</TableHead>
                      <TableHead className="text-right text-xs w-16">Disc %</TableHead>
                      <TableHead className="text-right text-xs pr-4 w-28">Total</TableHead>
                    </React.Fragment>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {comparison.rows.map((row, rIdx) => {
                  let minTotal = Infinity;
                  row.vendors.forEach(v => {
                    if (v.totalPrice !== null && v.totalPrice !== undefined && v.totalPrice < minTotal) minTotal = v.totalPrice;
                  })

                  const hasVariants = row.vendors.some(v => v.lineItems.length > 1)
                  const isExpanded = expandedRows.has(rIdx)

                  return (
                  <React.Fragment key={rIdx}>
                    <TableRow className="hover:bg-muted/10 group">
                      <TableCell className="font-medium sticky left-0 bg-background group-hover:bg-muted/10 z-10 border-r shadow-[1px_0_0_0_var(--border)]">
                        {hasVariants ? (
                          <button
                            type="button"
                            onClick={() => toggleRowExpanded(rIdx)}
                            className="flex items-center gap-1.5 text-left hover:text-primary"
                          >
                            {isExpanded ? <ChevronDown className="w-3.5 h-3.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 shrink-0" />}
                            <span className="truncate max-w-[260px] block">{row.category}</span>
                          </button>
                        ) : (
                          <span className="truncate max-w-[280px] block pl-5">{row.category}</span>
                        )}
                      </TableCell>

                      {row.vendors.map(v => {
                        const isLowest = v.available && v.totalPrice === minTotal && minTotal !== Infinity;
                        if (!v.available) {
                          return (
                            <React.Fragment key={v.quotationId}>
                              <TableCell className="border-l text-center text-muted-foreground/40">-</TableCell>
                              <TableCell className="text-center text-muted-foreground/40">-</TableCell>
                              <TableCell className="text-center text-muted-foreground/40">-</TableCell>
                              <TableCell className="text-center text-muted-foreground/40">-</TableCell>
                              <TableCell className="text-center text-muted-foreground/40">-</TableCell>
                              <TableCell className="text-center text-muted-foreground/40 pr-4">-</TableCell>
                            </React.Fragment>
                          )
                        }
                        return (
                          <React.Fragment key={v.quotationId}>
                            <TableCell className="border-l text-xs text-muted-foreground">
                              {v.spec ?? '-'}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {v.quantity ?? '-'}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {formatCurrency(v.mrp)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {formatCurrency(v.unitPrice)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {v.discountPercent != null ? `${v.discountPercent}%` : '-'}
                            </TableCell>
                            <TableCell className={`text-right tabular-nums pr-4 font-medium ${isLowest ? 'text-emerald-600 bg-emerald-50/50 dark:text-emerald-400 dark:bg-emerald-950/20' : ''}`}>
                              {formatCurrency(v.totalPrice)}
                            </TableCell>
                          </React.Fragment>
                        )
                      })}
                    </TableRow>

                    {hasVariants && isExpanded && (
                      <TableRow className="bg-muted/5 hover:bg-muted/5">
                        <TableCell className="sticky left-0 bg-muted/5 z-10 border-r shadow-[1px_0_0_0_var(--border)] align-top text-xs text-muted-foreground pl-5 py-2">
                          Size / variant breakdown
                        </TableCell>
                        {row.vendors.map(v => (
                          <TableCell key={`variants-${v.quotationId}`} colSpan={6} className="border-l align-top p-0">
                            {v.lineItems.length > 0 ? (
                              <table className="w-full text-xs">
                                <tbody>
                                  {v.lineItems.map((item, li) => (
                                    <tr key={li} className="border-b last:border-b-0 border-border/50">
                                      <td className="py-1 px-2 text-muted-foreground whitespace-normal">
                                        {item.vendorItemName}{item.spec ? ` — ${item.spec}` : ''}
                                      </td>
                                      <td className="py-1 px-2 text-right tabular-nums text-muted-foreground w-14">{item.quantity}</td>
                                      <td className="py-1 px-2 text-right tabular-nums text-muted-foreground w-20">{formatCurrency(item.mrp)}</td>
                                      <td className="py-1 px-2 text-right tabular-nums text-muted-foreground w-24">{formatCurrency(item.unitPrice)}</td>
                                      <td className="py-1 px-2 text-right tabular-nums text-muted-foreground w-14">{item.discountPercent != null ? `${item.discountPercent}%` : '-'}</td>
                                      <td className="py-1 px-4 text-right tabular-nums font-medium w-24">{formatCurrency(item.totalPrice)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            ) : (
                              <div className="py-2 px-2 text-xs text-muted-foreground/50 text-center">Not offered</div>
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                    )}
                  </React.Fragment>
                  )
                })}

                {/* Additional Info Rows */}
                {comparison.additionalInfo.length > 0 && (
                  <>
                    <TableRow className="border-t-2">
                      <TableCell colSpan={1 + comparison.vendors.length * 6} className="h-4 p-0"></TableCell>
                    </TableRow>
                    {comparison.additionalInfo.filter((info) => !CHARGE_LABEL_SET.has(info.label)).map((info, idx) => (
                      <TableRow key={`info-${idx}`} className="bg-muted/5 hover:bg-muted/10">
                        <TableCell className="font-medium text-muted-foreground sticky left-0 bg-muted/5 z-10 border-r shadow-[1px_0_0_0_var(--border)]">
                          {info.label}
                        </TableCell>
                        {comparison.vendors.map(v => {
                          const val = info.vendors.find(iv => iv.quotationId === v.id)?.value
                          return (
                            <TableCell key={`info-${idx}-${v.id}`} colSpan={6} className="border-l text-left text-sm text-muted-foreground px-4">
                              {val || '-'}
                            </TableCell>
                          )
                        })}
                      </TableRow>
                    ))}
                  </>
                )}

                {/* Charges & totals — calculated from the line items and the charges each vendor quoted */}
                <TableRow className="border-t-2">
                  <TableCell colSpan={1 + comparison.vendors.length * 6} className="h-4 p-0"></TableCell>
                </TableRow>
                <TableRow className="bg-muted/10 hover:bg-muted/10">
                  <TableCell className="font-semibold sticky left-0 bg-muted/10 z-10 border-r shadow-[1px_0_0_0_var(--border)]">Items Subtotal</TableCell>
                  {renderChargeCells("sub", (b) => ({ note: null, amount: formatCurrency(b.itemsSubtotal), amountClass: "font-semibold" }))}
                </TableRow>
                {CHARGE_KEYS.map((key) => (
                  <TableRow key={`charge-${key}`} className="hover:bg-muted/10">
                    <TableCell className="font-medium text-muted-foreground sticky left-0 bg-background z-10 border-r shadow-[1px_0_0_0_var(--border)]">{CHARGE_LABELS[key]}</TableCell>
                    {renderChargeCells(key, (b) => {
                      const line = b.lines.find((l) => l.key === key)!
                      const note =
                        line.itemisedAmount > 0 ? `Already listed as an item above (${formatCurrency(line.itemisedAmount)}) — not added again`
                        : line.waived ? `${line.basis} — no charge`
                        : line.basis ?? "Not stated"
                      return { note, amount: line.itemisedAmount > 0 || !line.basis ? "-" : formatCurrency(line.amount) }
                    })}
                  </TableRow>
                ))}
                <TableRow className="bg-muted/10 hover:bg-muted/10">
                  <TableCell className="font-semibold sticky left-0 bg-muted/10 z-10 border-r shadow-[1px_0_0_0_var(--border)]">Total before GST</TableCell>
                  {renderChargeCells("taxable", (b) => ({ note: null, amount: formatCurrency(b.taxableValue), amountClass: "font-semibold" }))}
                </TableRow>
                <TableRow className="hover:bg-muted/10">
                  <TableCell className="font-medium text-muted-foreground sticky left-0 bg-background z-10 border-r shadow-[1px_0_0_0_var(--border)]">GST</TableCell>
                  {renderChargeCells("gst", (b) => {
                    const { gst } = b
                    const note = gst.included
                      ? `${gst.basis} — already included in the prices above, nothing added`
                      : gst.rate != null
                        ? `${gst.rate}% of ${formatCurrency(b.taxableValue)} (calculated)`
                        : gst.basis
                          ? `${gst.basis} — amount as stated by vendor, rate unknown`
                          : <span className="text-amber-600">GST not stated — not included in the total below</span>
                    return { note, amount: gst.basis || gst.amount ? formatCurrency(gst.amount) : "-" }
                  })}
                </TableRow>
              </TableBody>
              <TableFooter className="bg-primary/5 border-t-2 font-bold">
                <TableRow>
                  <TableCell className="text-right text-base sticky left-0 bg-primary/5 z-10 border-r shadow-[1px_0_0_0_var(--border)]">
                    GRAND TOTAL <span className="block text-[10px] font-normal text-muted-foreground">(incl. GST)</span>
                  </TableCell>
                  {comparison.vendors.map(v => {
                    const b = vendorCharges.get(v.id)
                    const quoted = comparison.grandTotals.find(g => g.quotationId === v.id)?.total ?? null
                    const diff = b && quoted != null ? b.grandTotal - quoted : null
                    const isLowest = summary?.lowestVendor === v.vendorName
                    return (
                      <TableCell key={`gt-${v.id}`} colSpan={6} className={`border-l text-right pr-4 tabular-nums ${isLowest ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-100/50 dark:bg-emerald-900/30' : ''}`}>
                        <div className="text-lg">{formatCurrency(b?.grandTotal)}</div>
                        {diff != null && (
                          <div className={`text-[10px] font-normal ${Math.abs(diff) < 1 ? 'text-emerald-600' : 'text-amber-600'}`}>
                            {Math.abs(diff) < 1
                              ? `✓ Matches the vendor's quoted total (${formatCurrency(quoted)})`
                              : `⚠ Vendor quoted ${formatCurrency(quoted)} — our calculation is ${formatCurrency(Math.abs(diff))} ${diff < 0 ? 'lower' : 'higher'}`}
                          </div>
                        )}
                      </TableCell>
                    )
                  })}
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        </Card>
      )}

      {/* Other items offered (not part of the requested comparison) */}
      {comparison && comparison.otherItems.length > 0 && (
        <Card>
          <CardHeader className="py-4 border-b">
            <CardTitle className="text-lg">Other Items Offered</CardTitle>
            <CardDescription>Extras and accessories vendors included that weren't part of your comparison categories.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table className="whitespace-nowrap">
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead>Spec</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">MRP</TableHead>
                    <TableHead className="text-right">Rate</TableHead>
                    <TableHead className="text-right">Disc %</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {comparison.otherItems.map((item, idx) => (
                    <TableRow key={idx}>
                      <TableCell className="font-medium">{item.vendorName}</TableCell>
                      <TableCell>{item.vendorItemName}</TableCell>
                      <TableCell className="text-muted-foreground">{item.spec ?? '-'}</TableCell>
                      <TableCell className="text-right tabular-nums">{item.quantity}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(item.mrp)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(item.unitPrice)}</TableCell>
                      <TableCell className="text-right tabular-nums">{item.discountPercent != null ? `${item.discountPercent}%` : '-'}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{formatCurrency(item.totalPrice)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      {!comparison && hasParsedQuotations && !loadingComparison && (
         <div className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground border rounded-lg bg-card">
           <AlertCircle className="w-10 h-10 mb-4 opacity-50" />
           <p className="font-medium">Could not generate comparison</p>
           <p className="text-sm mt-1">Make sure a benchmark quotation is selected and data is valid.</p>
         </div>
      )}
      {comparison && project && showExportPreview && (
        <ExportPreviewModal
          open={showExportPreview}
          onClose={() => setShowExportPreview(false)}
          comparison={comparison}
          project={project}
          projectId={projectId}
          basePath={import.meta.env.BASE_URL}
        />
      )}
    </div>
  )
}
