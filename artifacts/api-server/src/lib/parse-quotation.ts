import Anthropic from "@anthropic-ai/sdk";

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY must be set.");
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";

export interface ItemFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  highlight?: boolean;
}

// Per-column formatting, keyed by field name (vendorItemName, spec, quantity, mrp,
// unitPrice, discountPercent, totalPrice) or a custom column id.
export type ItemFormatMap = Record<string, ItemFormat>;

export interface ParsedItem {
  matchedCategory: string | null; // exact string from the project's targetItems, or null if this item doesn't correspond to any of them
  vendorItemName: string; // what the vendor actually calls it in their document
  spec: string | null; // capacity/size/model spec, e.g. "9 KW", "12x3 inch"
  quantity: number;
  mrp: number | null;
  unitPrice: number; // unit price after discount
  discountPercent: number | null;
  totalPrice: number;
  format?: ItemFormatMap; // per-column text styling set by the user in the grid editor — never set by AI extraction
  customFields?: Record<string, string>; // values for the project's custom shared columns, keyed by CustomColumn id
  // Per-row charge columns. Null/absent means "use the default" (vendor's GST rate or 18%, and this row's share
  // of any lump-sum charges); a number is a value the user typed for this row. Never set by AI extraction.
  gstPercent?: number | null;
  freight?: number | null;
  otherCharges?: number | null;
}

export interface AdditionalInfo {
  designingCharges: string | null;
  gst: string | null;
  installation: string | null;
  freight: string | null;
  leadTime: string | null;
  samplesForReview: string | null;
  paymentSchedule: string | null;
  warranty: string | null;
}

export interface ParsedQuotation {
  vendorName: string | null;
  vendorAddress: string | null;
  vendorContact: string | null;
  items: ParsedItem[];
  additionalInfo: AdditionalInfo;
  grandTotal: number | null;
}

function buildSystemPrompt(targetItems: string[]): string {
  const list = targetItems.map((t) => `- ${t}`).join("\n");
  return `You are a procurement assistant. Extract structured quotation data from vendor documents by calling the extract_quotation tool.

The user is comparing quotes from different vendors against this fixed set of categories:
${list}

Vendors phrase things differently — e.g. "Control Plates", "Control Kit", and "Control Panel" might all mean the same category. Use your judgment to map each line item in the document to the category it most closely corresponds to, even if the vendor's wording is completely different.

Rules:
- For EVERY line item in the document, set "matchedCategory" to the category from the list above it corresponds to (use the EXACT string from the list). If a line item does not correspond to ANY category in the list (e.g. a bonus/free accessory, or something not requested), set "matchedCategory" to null — do not force a match.
- Set "vendorItemName" to the item's name exactly as written in the document.
- Set "spec" to any capacity/size/model detail that distinguishes this item (e.g. "9 KW", "12x3 inch"), or null if none.
- Extract "mrp" (list price before discount) and "discountPercent" when shown, separately from "unitPrice" (the price after discount). Use null for any that aren't shown.
- Some items (e.g. windows/glass/fabric priced by area) show TWO different rate figures: a per-area rate (e.g. "Value per Sq.Ft.", "Rate per Sq.Mtr.") and a separate per-unit price (e.g. "Unit Price") that already equals that per-area rate × the item's area. Always use the per-unit price — the one that actually multiplies with "quantity" (the count of pieces/windows/Nos) to approximate the item's total — for "unitPrice". Do not use the smaller per-area rate just because it looks like "the" rate; that figure belongs in "spec" as context (e.g. "23.98 sqft/window @ ₹968.55/sqft"), not in "unitPrice".
- Set "quantity" to exactly the number in the document's own quantity/qty/nos column for that line item. Never compute or infer a quantity from unrelated numbers elsewhere in the description — e.g. an area calculation like "13x9=117 sqft" inside an item's description is NOT the quantity unless the quantity column itself says 117. Put that kind of detail in "spec" instead, and copy the quantity column's value as-is, even if it's just "1".
- Set "totalPrice" to exactly the amount/total the document states for that line item. Do not calculate it yourself as quantity × unitPrice — vendors sometimes price per a different unit than the quantity column (e.g. rate given per sqft while quantity is in Nos), so the two won't always multiply out.
- Documents may be provided as HTML with <table> markup. Some vendor tables cram multiple line items into a single table cell as several stacked paragraphs instead of using separate rows (e.g. one cell holding several stacked quantities for several different items, aligned by position with stacked descriptions in another cell). When you see this, match paragraphs by their position/order within each column — the Nth paragraph in one cell corresponds to the Nth paragraph in another — and ignore stray blank paragraphs. Still extract EVERY line item exactly once, even when the correspondence between columns takes judgment; don't drop an item just because its cell alignment isn't perfectly explicit.
- Prices should be numbers only (no currency symbols).
- Pay close attention to table columns — do not merge or misalign values from adjacent columns or rows.
- If a value is missing or unclear, use null.`;
}

function buildExtractionTool(targetItems: string[]): Anthropic.Tool {
  return {
    name: "extract_quotation",
    description: "Record structured vendor quotation data extracted from a document.",
    input_schema: {
      type: "object",
      properties: {
        vendorName: { type: ["string", "null"], description: "Vendor/company name, or null if not stated anywhere in the document" },
        vendorAddress: { type: ["string", "null"] },
        vendorContact: { type: ["string", "null"] },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              matchedCategory: {
                type: ["string", "null"],
                enum: [...targetItems, null],
                description: "Which target category this item corresponds to, or null if it doesn't match any",
              },
              vendorItemName: { type: "string", description: "Item name exactly as written by the vendor" },
              spec: { type: ["string", "null"], description: "Capacity/size/model spec, e.g. '9 KW'. Also the place for area/size math (e.g. '13x9=117 sqft') found in the description — that is NOT the quantity." },
              quantity: { type: "number", description: "The number from the document's own quantity/qty/nos column for this line item, copied exactly — never inferred or computed from other figures" },
              mrp: { type: ["number", "null"], description: "List price before discount" },
              unitPrice: { type: "number", description: "Price per unit (piece/window/Nos) after discount. If the document also shows a per-area rate like 'Value per Sq.Ft.', that is NOT this — use the per-unit price instead (the one that multiplies with quantity to give the total)." },
              discountPercent: { type: ["number", "null"] },
              totalPrice: { type: "number", description: "The amount/total the document states for this line item, copied exactly — not computed as quantity × unitPrice" },
            },
            required: ["matchedCategory", "vendorItemName", "spec", "quantity", "mrp", "unitPrice", "discountPercent", "totalPrice"],
          },
        },
        additionalInfo: {
          type: "object",
          properties: {
            designingCharges: { type: ["string", "null"], description: "Designing charges as quoted (e.g. '₹5,000' or '2%'), or null if absent or already captured as a priced line item" },
            gst: { type: ["string", "null"], description: "The GST rate or wording exactly as quoted (e.g. 'IGST @ 18%', 'CGST 9% + SGST 9%', 'Inclusive of GST'). If GST is split into CGST and SGST (or UTGST), keep BOTH parts. Do not put the vendor's computed GST amount here when a percentage is given." },
            installation: { type: ["string", "null"], description: "Installation charges as quoted (e.g. '₹10,000' or '3%'), or null if absent or already captured as a priced line item" },
            freight: { type: ["string", "null"], description: "Freight/cartage charges as quoted (e.g. '₹12,000' or 'Extra at actuals'), or null if absent or already captured as a priced line item" },
            leadTime: { type: ["string", "null"] },
            samplesForReview: { type: ["string", "null"], description: "YES/NO or description" },
            paymentSchedule: { type: ["string", "null"] },
            warranty: { type: ["string", "null"] },
          },
          required: ["designingCharges", "gst", "installation", "freight", "leadTime", "samplesForReview", "paymentSchedule", "warranty"],
        },
        grandTotal: { type: ["number", "null"] },
      },
      required: ["vendorName", "vendorAddress", "vendorContact", "items", "additionalInfo", "grandTotal"],
    },
  };
}

function extractToolInput(response: Anthropic.Message): ParsedQuotation {
  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === "extract_quotation",
  );
  if (!toolUse) {
    throw new Error("Claude did not return a structured extraction");
  }
  return toolUse.input as ParsedQuotation;
}

export async function parseQuotationText(text: string, targetItems: string[]): Promise<ParsedQuotation> {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: buildSystemPrompt(targetItems),
    tools: [buildExtractionTool(targetItems)],
    tool_choice: { type: "tool", name: "extract_quotation" },
    messages: [{ role: "user", content: `Extract quotation data from this document:\n\n${text}` }],
  });

  return extractToolInput(response);
}

export async function parseQuotationPdf(pdfBuffer: Buffer, targetItems: string[]): Promise<ParsedQuotation> {
  const base64 = pdfBuffer.toString("base64");

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: buildSystemPrompt(targetItems),
    tools: [buildExtractionTool(targetItems)],
    tool_choice: { type: "tool", name: "extract_quotation" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64 },
          },
          { type: "text", text: "Extract all quotation data from this document." },
        ],
      },
    ],
  });

  return extractToolInput(response);
}

export async function parseQuotationImage(imageBuffer: Buffer, mimeType: string, targetItems: string[]): Promise<ParsedQuotation> {
  const base64 = imageBuffer.toString("base64");
  const mediaType = mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp";

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: buildSystemPrompt(targetItems),
    tools: [buildExtractionTool(targetItems)],
    tool_choice: { type: "tool", name: "extract_quotation" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64 },
          },
          { type: "text", text: "Extract all quotation data from this image." },
        ],
      },
    ],
  });

  return extractToolInput(response);
}
