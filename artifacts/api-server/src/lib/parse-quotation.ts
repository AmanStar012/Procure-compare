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
              spec: { type: ["string", "null"], description: "Capacity/size/model spec, e.g. '9 KW'" },
              quantity: { type: "number" },
              mrp: { type: ["number", "null"], description: "List price before discount" },
              unitPrice: { type: "number", description: "Price per unit after discount" },
              discountPercent: { type: ["number", "null"] },
              totalPrice: { type: "number" },
            },
            required: ["matchedCategory", "vendorItemName", "spec", "quantity", "mrp", "unitPrice", "discountPercent", "totalPrice"],
          },
        },
        additionalInfo: {
          type: "object",
          properties: {
            designingCharges: { type: ["string", "null"] },
            gst: { type: ["string", "null"], description: "GST percentage or amount" },
            installation: { type: ["string", "null"], description: "Installation notes, if not already captured as a priced line item" },
            freight: { type: ["string", "null"], description: "Cartage or freight charges" },
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
