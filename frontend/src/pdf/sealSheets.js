import { PageSizes, PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { createQRedQrSymbol } from "../qredQr.js";
import { createEntryQrSymbol } from "./navigationQr.js";
import { visiblePageGeometry } from "./pageScaling.js";
import { drawQrSymbol } from "./qrDrawing.js";
import { planSealSheetLayout, SEALS_PER_SHEET, SEAL_SHEET_MARGIN } from "./sealSheetLayout.js";

export const usesSealSheets = strategy => strategy === "seal-sheets" || strategy === "watermark-sheets";
export const usesWatermarks = strategy => ["automatic", "watermark", "watermark-sheets"].includes(strategy);

function drawInstructions(page, width, height, font, bold) {
  const margin = SEAL_SHEET_MARGIN, top = height - 70, bottom = top - 80;
  const available = width - 2 * margin;
  const firstWidth = 216, nextWidth = (available - firstWidth) / 2;
  const starts = [margin, margin + firstWidth, margin + firstWidth + nextWidth];
  // A distinct start panel binds the only navigation QR to the phone-camera
  // instruction. All instructions remain understandable in monochrome print.
  page.drawRectangle({ x: margin, y: bottom, width: firstWidth - 6, height: 80, color: rgb(.95, .95, .95) });
  ["Open QRed.org", "Scan the seals", "Photo the pages"].forEach((title, index) => {
    const x = starts[index] + 8;
    page.drawCircle({ x: x + 8, y: top - 14, size: 8, color: rgb(0, 0, 0) });
    page.drawText(String(index + 1), { x: x + 5.2, y: top - 17.5, size: 10, font: bold, color: rgb(1, 1, 1) });
    page.drawText(title, { x: x + 22, y: top - 18, size: 12, font: bold });
  });
  const entry = { x: margin + 8, y: bottom + 4, width: 54, height: 54 };
  page.drawRectangle({ ...entry, color: rgb(1, 1, 1) });
  drawQrSymbol(page, createEntryQrSymbol(), entry, 0);
  const lines = [
    ["Scan this small QR", "with your phone camera.", "Or visit QRed.org."],
    ["Use QRed to scan all", "large seals. Whole sheet", "or one seal at a time."],
    ["Then use QRed to", "photograph each", "original document page."],
  ];
  lines.forEach((step, index) => step.forEach((text, line) => {
    page.drawText(text, { x: starts[index] + (index === 0 ? 70 : 8), y: top - 38 - line * 13, size: 10, font });
  }));
}

// Up to six pieces of the document bundle per sheet. The original page order
// is recovered from signed records, not from labels beside individual codes.
export async function appendSealSheets(bytes, entries, originalCount) {
  if (!entries.length) return { bytes, sheetCount: 0 };
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  if (pdf.getPageCount() !== originalCount) throw new Error("The original PDF page count changed.");
  const first = visiblePageGeometry(pdf.getPage(0));
  const isA4 = Math.abs(Math.min(first.width, first.height) - PageSizes.A4[0]) < 3 &&
    Math.abs(Math.max(first.width, first.height) - PageSizes.A4[1]) < 3;
  const [width, height] = isA4 ? PageSizes.A4 : PageSizes.Letter;
  const margin = SEAL_SHEET_MARGIN;
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const sheetCount = Math.ceil(entries.length / SEALS_PER_SHEET);
  for (let sheet = 0; sheet < sheetCount; sheet++) {
    const page = pdf.addPage([width, height]);
    page.drawText("Check this document", { x: margin, y: height - 54, size: 19, font: bold });
    const sheetLabel = `Seal sheet ${sheet + 1} of ${sheetCount}`;
    page.drawText(sheetLabel, { x: width - margin - font.widthOfTextAtSize(sheetLabel, 10), y: height - 52, size: 10, font });
    drawInstructions(page, width, height, font, bold);
    const sheetEntries = entries.slice(sheet * SEALS_PER_SHEET, (sheet + 1) * SEALS_PER_SHEET);
    const boxes = planSealSheetLayout(width, height, sheetEntries.length);
    sheetEntries.forEach(({ seal }, slot) => {
      const { labelY, ...box } = boxes[slot];
      const label = `Seal ${sheet * SEALS_PER_SHEET + slot + 1} of ${entries.length}`;
      page.drawText(label, { x: box.x + (box.width - font.widthOfTextAtSize(label, 9)) / 2, y: labelY, size: 9, font });
      const symbol = createQRedQrSymbol(seal);
      drawQrSymbol(page, symbol, box, 0);
    });
    page.drawText("Follow QRed's prompts to review the results.", { x: margin, y: 30, size: 10, font });
  }
  return { bytes: await pdf.save({ updateFieldAppearances: false }), sheetCount };
}
