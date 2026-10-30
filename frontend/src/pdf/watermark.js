import { BlendMode, rgb, StandardFonts } from "pdf-lib";
import QRCode from "qrcode";
import { createQRedQrSymbol } from "../qredQr.js";
import { scanQrImage } from "../qr/scanQrImage.js";
import { hiddenPayloadFromScanResult } from "../qr/hiddenPayload.js";
import { renderPdfPage, withPdfDocument } from "./readPdfText.js";
import { planWatermarks } from "./watermarkPlacement.js";
import { scanAllSealsFromPage, simulatePrintPhoto } from "./watermarkPreflight.js";

export { planWatermarks } from "./watermarkPlacement.js";

export const ENTRY_URL = "https://qred.org/";
export const ENTRY_QR_SIZE = 36;
// Fifteen-percent black survives more printer gray-tone loss than the old 6%.
// Keep it pale enough to preserve the readability of underlying black text.
export const WATERMARK_GRAY = 0.85;
const MARGIN = 18;
const ENTRY_WIDTH = 70, ENTRY_HEIGHT = 52;

// Count every visible nonwhite pixel, including graphics and annotations.
// Never infer empty space from extracted text alone.
export function findEntryPlacement(image) {
  const { data, width, height, scale, bounds } = image;
  const stride = width + 1;
  const ink = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (Math.min(data[i], data[i + 1], data[i + 2]) < 250) row++;
      ink[(y + 1) * stride + x + 1] = ink[y * stride + x + 1] + row;
    }
  }
  // Bottom first, then top, then work inward. Favor the right corner so the
  // small navigation code usually stays outside the main body of the page.
  const ys = new Set([MARGIN, bounds.height - MARGIN - ENTRY_HEIGHT]);
  for (let y = MARGIN; y <= bounds.height - MARGIN - ENTRY_HEIGHT; y += 6) ys.add(y);
  for (const y of ys) {
    for (let x = bounds.width - MARGIN - ENTRY_WIDTH; x >= MARGIN; x -= 6) {
      if (y < MARGIN) continue;
      const left = Math.max(0, Math.floor((x - 3) * scale));
      const right = Math.min(width, Math.ceil((x + ENTRY_WIDTH + 3) * scale));
      const top = Math.max(0, Math.floor((bounds.height - y - ENTRY_HEIGHT - 3) * scale));
      const bottom = Math.min(height, Math.ceil((bounds.height - y + 3) * scale));
      if (ink[bottom * stride + right] - ink[top * stride + right]
          - ink[bottom * stride + left] + ink[top * stride + left] === 0) {
        return { x: bounds.x + x, y: bounds.y + y, width: ENTRY_WIDTH, height: ENTRY_HEIGHT };
      }
    }
  }
  throw new Error("No clear space on the first page for the small qred.org code. Choose a footer layout or provide a PDF with a blank area at least 1.1 by 0.8 inches.");
}

function drawSymbol(page, symbol, box, gray, multiply = false) {
  const count = symbol.modules.size, unit = box.width / (count + 8);
  const paths = [];
  for (let row = 0; row < count; row++) {
    let column = 0;
    while (column < count) {
      if (!symbol.modules.get(row, column)) { column++; continue; }
      const start = column;
      while (column < count && symbol.modules.get(row, column)) column++;
      const run = column - start;
      paths.push(`M${start} ${row}h${run}v1h-${run}z`);
    }
  }
  // Multiply leaves black text black, even over an opaque white PDF background.
  // One vector path per symbol keeps printed modules sharp at any resolution.
  page.drawSvgPath(paths.join(""), { x: box.x + 4 * unit, y: box.y + box.height - 4 * unit,
    scale: unit, color: rgb(gray, gray, gray), blendMode: multiply ? BlendMode.Multiply : BlendMode.Normal });
}

export async function planPdfWatermarks(file, pageSealResults, pageIndices = pageSealResults.map((_, index) => index)) {
  const layouts = new Array(pageSealResults.length).fill(null);
  await withPdfDocument(file, async (source) => {
    let entry = null;
    for (const index of pageIndices) {
      const seals = pageSealResults[index].seals;
      if (seals.length > 4) throw new Error(`Page ${index + 1} needs too many watermarks. Choose a footer layout.`);
      const sourcePage = await source.getPage(index + 1);
      if (sourcePage.userUnit !== 1) { sourcePage.cleanup(); continue; }
      const viewport = sourcePage.getViewport({ scale: 2, rotation: 0 });
      if (viewport.width * viewport.height > 12_000_000) { sourcePage.cleanup(); continue; }
      const image = await renderPdfPage(source, index + 1);
      if (index === 0) {
        try { entry = findEntryPlacement(image); } catch { sourcePage.cleanup(); continue; }
      }
      const symbols = seals.map(value => createQRedQrSymbol(value));
      let boxes;
      try { boxes = planWatermarks(image, symbols, index === 0 ? entry : null); }
      catch { sourcePage.cleanup(); continue; }
      layouts[index] = { boxes, ...(index === 0 ? { entry } : {}) };
      sourcePage.cleanup();
    }
  });
  return layouts;
}

// Apply the already-selected geometry. If another page needs a footer, the
// document can be rebuilt without analyzing or selecting placements again.
export async function stampWatermarks(pdf, layouts, pageSealResults) {
  for (let index = 0; index < layouts.length; index++) {
    if (!layouts[index]) continue;
    pageSealResults[index].seals.forEach((value, part) => {
      drawSymbol(pdf.getPage(index), createQRedQrSymbol(value), layouts[index].boxes[part], WATERMARK_GRAY, true);
    });
  }
  const entry = layouts[0]?.entry;
  if (entry) {
    const page = pdf.getPage(0);
    // The box was checked before any watermark was drawn, and the watermark
    // layout excludes it. Its white quiet zone never covers source content.
    page.drawRectangle({ ...entry, color: rgb(1, 1, 1) });
    drawSymbol(page, QRCode.create(ENTRY_URL, { errorCorrectionLevel: "M" }),
      { x: entry.x + (entry.width - ENTRY_QR_SIZE) / 2, y: entry.y + 12, width: ENTRY_QR_SIZE, height: ENTRY_QR_SIZE }, 0);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const caption = "Verify at qred.org";
    page.drawText(caption, { x: entry.x + (entry.width - font.widthOfTextAtSize(caption, 7)) / 2,
      y: entry.y + 3, size: 7, font, color: rgb(0, 0, 0) });
  }
}

function crop(image, box) {
  const x = Math.max(0, Math.floor((box.x - image.bounds.x) * image.scale));
  const y = Math.max(0, Math.floor((image.bounds.y + image.bounds.height - box.y - box.height) * image.scale));
  const width = Math.min(image.width - x, Math.ceil(box.width * image.scale));
  const height = Math.min(image.height - y, Math.ceil(box.height * image.scale));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const offset = ((y + row) * image.width + x) * 4;
    data.set(image.data.subarray(offset, offset + width * 4), row * width * 4);
  }
  return { data, width, height };
}

// Preflight each watermark against exact-payload decoding, mild simulated
// print/photo degradation and full-page discovery. Any failure uses a footer.
// Physical printer/camera tests remain necessary; simulations cannot promise
// compatibility with every device.
export async function checkWatermarks(bytes, layouts, pageSealResults) {
  const failed = new Set();
  await withPdfDocument(new Blob([bytes], { type: "application/pdf" }), async (pdf) => {
    for (let index = 0; index < layouts.length; index++) {
      if (!layouts[index]) continue;
      const image = await renderPdfPage(pdf, index + 1);
      for (let part = 0; part < layouts[index].boxes.length; part++) {
        const qr = crop(image, layouts[index].boxes[part]);
        const code = scanQrImage(qr.data, qr.width, qr.height,
          { tryRescaling: false, maxAttempts: 3 });
        const expected = pageSealResults[index].seals[part];
        if (hiddenPayloadFromScanResult(code) !== expected) {
          failed.add(index);
          break;
        }
        // A clean PDF render is too forgiving. Check a softened, slightly
        // shaded print-like image and require the complete signed payload.
        const photo = simulatePrintPhoto(qr);
        if (hiddenPayloadFromScanResult(scanQrImage(photo.data, photo.width, photo.height,
          { tryRescaling: false, maxAttempts: 3 })) !== expected) {
          failed.add(index);
          break;
        }
      }
      // A known-position crop is easier to decode than a photographed sheet.
      // Require the verifier to locate *every* seal on the full page as well.
      if (!failed.has(index) && !scanAllSealsFromPage(image, pageSealResults[index].seals)) {
        failed.add(index);
      }
      if (layouts[index].entry) {
        const qr = crop(image, layouts[index].entry);
        if (scanQrImage(qr.data, qr.width, qr.height, { tryWatermark: false })?.data !== ENTRY_URL) {
          failed.add(index);
        }
      }
    }
  });
  return [...failed];
}
