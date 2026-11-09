import { PageSizes, PDFDocument, StandardFonts } from "pdf-lib";
import { sealSheetString } from "../sealFormat.js";
import { createQRedQrSymbol } from "../qredQr.js";
import { createEntryQrSymbol } from "./navigationQr.js";
import { visiblePageGeometry } from "./pageScaling.js";
import { drawQrSymbol } from "./qrDrawing.js";

export const usesSealSheets = strategy => strategy === "seal-sheets" || strategy === "watermark-sheets";
export const usesWatermarks = strategy => ["automatic", "watermark", "watermark-sheets"].includes(strategy);

// One printable 2x2 grid can carry pieces belonging to different originals.
// Labels use the signed original-page order, even if one record spans sheets.
export async function appendSealSheets(bytes, entries, originalCount) {
  if (!entries.length) return { bytes, sheetCount: 0 };
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  if (pdf.getPageCount() !== originalCount) throw new Error("The original PDF page count changed.");
  const first = visiblePageGeometry(pdf.getPage(0));
  const isA4 = Math.abs(Math.min(first.width, first.height) - PageSizes.A4[0]) < 3 &&
    Math.abs(Math.max(first.width, first.height) - PageSizes.A4[1]) < 3;
  const [width, height] = isA4 ? PageSizes.A4 : PageSizes.Letter;
  const margin = 54, gap = 18, qrSize = (width - 2 * margin - gap) / 2;
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const sheetCount = Math.ceil(entries.length / 4);
  for (let sheet = 0; sheet < sheetCount; sheet++) {
    const page = pdf.addPage([width, height]);
    page.drawText(`QRed seal sheet ${sheet + 1} of ${sheetCount}`, { x: margin, y: height - 75, size: 19, font: bold });
    page.drawText("Scan the seals, then photograph the numbered original pages.", { x: margin, y: height - 96, size: 10, font });
    page.drawText("Verify at QRED.ORG", { x: margin, y: height - 112, size: 10, font });
    drawQrSymbol(page, createEntryQrSymbol(), { x: width - margin - 54, y: height - 108, width: 54, height: 54 }, 0);
    entries.slice(sheet * 4, sheet * 4 + 4).forEach(({ pageNumber, part, total, seal }, slot) => {
      const x = margin + (slot % 2) * (qrSize + gap);
      const y = height - 143 - Math.floor(slot / 2) * (qrSize + 40);
      page.drawText(`Original page ${pageNumber} of ${originalCount}`, { x, y, size: 12, font: bold });
      if (total > 1) page.drawText(`Seal ${part + 1} of ${total}`, { x, y: y - 14, size: 10, font });
      const symbol = createQRedQrSymbol(sealSheetString(seal));
      drawQrSymbol(page, symbol, { x, y: y - 18 - qrSize, width: qrSize, height: qrSize }, 0);
    });
  }
  return { bytes: await pdf.save({ updateFieldAppearances: false }), sheetCount };
}
