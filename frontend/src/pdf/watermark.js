import { BlendMode, rgb, StandardFonts } from "pdf-lib";
import QRCode from "qrcode";
import { createQRedQrSymbol } from "../qredQr.js";
import { scanQrImage } from "../qr/scanQrImage.js";
import { hiddenPayloadFromScanResult } from "../qr/hiddenPayload.js";
import { renderPdfPage, withPdfDocument } from "./readPdfText.js";

export const ENTRY_URL = "https://qred.org/";
export const ENTRY_QR_SIZE = 36;
export const WATERMARK_GRAY = 0.88;
const MARGIN = 18;
const MIN_MODULE_SIZE = 1.5;
const ENTRY_WIDTH = 44, ENTRY_HEIGHT = 52;

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
  throw new Error("No clear space on the first page for the small qred.org code. Choose a footer layout or provide a PDF with a blank area at least 0.7 by 0.8 inches.");
}

function intersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function planWatermarks(bounds, symbols, entry = null) {
  const area = { x: bounds.x + MARGIN, y: bounds.y + MARGIN,
    width: bounds.width - 2 * MARGIN, height: bounds.height - 2 * MARGIN };
  const areas = [area];
  if (entry) {
    const gap = 8;
    areas.push(
      { ...area, height: entry.y - gap - area.y },
      { ...area, y: entry.y + entry.height + gap, height: area.y + area.height - entry.y - entry.height - gap },
      { ...area, width: entry.x - gap - area.x },
      { ...area, x: entry.x + entry.width + gap, width: area.x + area.width - entry.x - entry.width - gap },
    );
  }
  let best = null;
  for (const space of areas) for (let columns = 1; columns <= symbols.length; columns++) {
    const rows = Math.ceil(symbols.length / columns), gap = 12;
    const size = Math.min((space.width - gap * (columns - 1)) / columns, (space.height - gap * (rows - 1)) / rows);
    if (!(size > 0) || symbols.some(symbol => size / (symbol.modules.size + 8) < MIN_MODULE_SIZE)) continue;
    const x0 = space.x + (space.width - columns * size - (columns - 1) * gap) / 2;
    const y0 = space.y + (space.height - rows * size - (rows - 1) * gap) / 2;
    const boxes = symbols.map((_, i) => ({ x: x0 + (i % columns) * (size + gap),
      y: y0 + (rows - 1 - Math.floor(i / columns)) * (size + gap), width: size, height: size }));
    if (entry && boxes.some(box => intersects(box, entry))) continue;
    if (!best || size > best[0].width) best = boxes;
  }
  if (!best) throw new Error("This page's seal data is too dense for readable experimental watermarks. Choose a footer layout.");
  return best;
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

export async function stampWatermarks(pdf, file, pageSealResults) {
  const layouts = [];
  await withPdfDocument(file, async (source) => {
    const firstImage = await renderPdfPage(source, 1);
    const entry = findEntryPlacement(firstImage);
    for (let index = 0; index < pageSealResults.length; index++) {
      const seals = pageSealResults[index].seals;
      if (seals.length > 4) throw new Error(`Page ${index + 1} needs too many watermarks. Choose a footer layout.`);
      const sourcePage = await source.getPage(index + 1);
      const [x, y, right, top] = sourcePage.view;
      if (sourcePage.userUnit !== 1) throw new Error("Experimental watermarks do not support this PDF's custom page units. Choose a footer layout.");
      const symbols = seals.map(value => createQRedQrSymbol(value));
      const boxes = planWatermarks({ x, y, width: right - x, height: top - y }, symbols, index === 0 ? entry : null);
      const page = pdf.getPage(index);
      symbols.forEach((symbol, i) => drawSymbol(page, symbol, boxes[i], WATERMARK_GRAY, true));
      layouts.push({ boxes, ...(index === 0 ? { entry } : {}) });
      sourcePage.cleanup();
    }
    const page = pdf.getPage(0);
    // The box was checked before any watermark was drawn, and the watermark
    // layout excludes it. Its white quiet zone never covers source content.
    page.drawRectangle({ ...entry, color: rgb(1, 1, 1) });
    drawSymbol(page, QRCode.create(ENTRY_URL, { errorCorrectionLevel: "M" }),
      { x: entry.x + 4, y: entry.y + 12, width: ENTRY_QR_SIZE, height: ENTRY_QR_SIZE }, 0);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText("qred.org", { x: entry.x + (entry.width - font.widthOfTextAtSize("qred.org", 7)) / 2,
      y: entry.y + 3, size: 7, font, color: rgb(0, 0, 0) });
  });
  return layouts;
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

// Reject digital layouts that our own scanner cannot read. This protects the
// opt-in experiment from opaque graphics and dense text; it does not claim
// that a printer/camera round trip will also succeed.
export async function checkWatermarks(bytes, layouts, pageSealResults) {
  await withPdfDocument(new Blob([bytes], { type: "application/pdf" }), async (pdf) => {
    for (let index = 0; index < layouts.length; index++) {
      const image = await renderPdfPage(pdf, index + 1);
      for (let part = 0; part < layouts[index].boxes.length; part++) {
        const qr = crop(image, layouts[index].boxes[part]);
        const code = scanQrImage(qr.data, qr.width, qr.height);
        if (hiddenPayloadFromScanResult(code) !== pageSealResults[index].seals[part]) {
          throw new Error(`The watermark on page ${index + 1} could not be read over this page's content. Choose a footer layout.`);
        }
      }
      if (layouts[index].entry) {
        const qr = crop(image, layouts[index].entry);
        if (scanQrImage(qr.data, qr.width, qr.height, { tryWatermark: false })?.data !== ENTRY_URL) {
          throw new Error("The small qred.org code could not be read. Choose a footer layout.");
        }
      }
    }
  });
}
