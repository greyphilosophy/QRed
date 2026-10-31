import { scanQrImage } from "../qr/scanQrImage.js";
import { decodeSeal, qredPayloadFromPhotoScanResult } from "../qredVerifier.js";
import { scanPageAlignedImage } from "../qr/pageAlignedScan.js";

const MAX_CODES_PER_PAGE = 64;
const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));

// Erase only a working raster, after recovery. Keep the original page image
// for comparison and never infer a seal from PDF metadata or extracted text.
function maskCode(data, width, height, code, offset) {
  const points = ["topLeftCorner", "topRightCorner", "bottomLeftCorner", "bottomRightCorner"]
    .map(name => code.location?.[name])
    .map(point => point && { x: point.x + offset.x, y: point.y + offset.y });
  if (points.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) return false;
  const left = Math.max(0, Math.floor(Math.min(...points.map(point => point.x))) - 2);
  const right = Math.min(width, Math.ceil(Math.max(...points.map(point => point.x))) + 2);
  const top = Math.max(0, Math.floor(Math.min(...points.map(point => point.y))) - 2);
  const bottom = Math.min(height, Math.ceil(Math.max(...points.map(point => point.y))) + 2);
  let changed = false;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const i = (y * width + x) * 4;
    changed ||= data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255;
    data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 255;
  }
  return changed;
}

function scanRegions(width, height) {
  // Tight quadrants isolate adjacent dense codes; overlapping halves preserve
  // quiet zones for codes crossing a split. Always try the complete page first.
  const w = Math.ceil(width * 0.6), h = Math.ceil(height * 0.6);
  const middleX = Math.floor(width / 2), middleY = Math.floor(height / 2);
  return [
    { x: 0, y: 0, width, height },
    ...[[0, middleX], [middleX, width]].flatMap(([left, right]) =>
      [[0, middleY], [middleY, height]].map(([top, bottom]) =>
        ({ x: left, y: top, width: right - left, height: bottom - top }))),
    ...[0, width - w].map(x => ({ x, y: 0, width: w, height })),
    ...[0, height - h].map(y => ({ x: 0, y, width, height: h })),
  ];
}

function regionPixels(pixels, width, region) {
  const data = new Uint8ClampedArray(region.width * region.height * 4);
  for (let row = 0; row < region.height; row++) {
    const start = ((region.y + row) * width + region.x) * 4;
    data.set(pixels.subarray(start, start + region.width * 4), row * region.width * 4);
  }
  return data;
}

export async function scanPdfPage(image, { onSeal = () => {}, signal, pageAligned = true } = {}) {
  const seals = new Set();
  // The page-aligned path is independent of QR finder detection and can
  // recover rectangular modules with virtual quiet zones. It sees only the
  // provided pixels; the original PDF's layout is never required.
  if (pageAligned) {
    signal?.throwIfAborted();
    const aligned = scanPageAlignedImage(image);
    for (const { seal } of aligned) {
      if (!decodeSeal(seal) || seals.has(seal)) continue;
      seals.add(seal);
      await onSeal(seal, image);
      signal?.throwIfAborted();
    }
    // A complete one- or four-symbol page has nothing more to discover.
    // Incomplete page scans still try the historical region-based locator.
    if (aligned.length === 4 || aligned.length === 1 && decodeSeal(aligned[0].seal)?.total_chunks === 1) {
      return { seals: [...seals], limited: false };
    }
  }
  const pixels = new Uint8ClampedArray(image.data);
  const regions = scanRegions(image.width, image.height);
  let codes = 0;
  for (let regionIndex = 0; regionIndex < regions.length; regionIndex++) {
    const region = regions[regionIndex];
    while (codes < MAX_CODES_PER_PAGE) {
      await yieldToBrowser();
      signal?.throwIfAborted();
      const data = regionPixels(pixels, image.width, region);
      if (data.every((value, index) => index % 4 === 3 || value === 255)) break;
      const code = scanQrImage(data, region.width, region.height);
      if (!code) break;
      codes++;
      const payload = qredPayloadFromPhotoScanResult(data, region.width, region.height, code);
      if (decodeSeal(payload) && !seals.has(payload)) {
        seals.add(payload);
        await onSeal(payload, image);
        signal?.throwIfAborted();
      }
      // Navigation and unrelated QR codes are skipped too, so they cannot hide
      // another seal elsewhere on the page. Bound work on hostile input.
      if (!maskCode(pixels, image.width, image.height, code, region)) return { seals: [...seals], limited: true };
      // Removing an isolated code can make the remaining full-page geometry
      // readable. Revisit it before trying more small views.
      if (regionIndex > 0) { regionIndex = -1; break; }
    }
    if (codes === MAX_CODES_PER_PAGE) return { seals: [...seals], limited: true };
  }
  return { seals: [...seals], limited: false };
}

export async function scanPdfSeals(file, { onSeal = () => {}, onProgress = () => {}, signal } = {}) {
  signal?.throwIfAborted();
  const { withPdfDocument, renderPdfPage } = await import("../pdf/readPdfText.js");
  signal?.throwIfAborted();
  try {
    return await withPdfDocument(file, async pdf => {
      const seen = new Set();
      const summary = { pageCount: pdf.numPages, pagesWithSeals: 0, sealCount: 0, missingPages: [], failedPages: [] };
      for (let number = 1; number <= pdf.numPages; number++) {
        signal?.throwIfAborted();
        onProgress({ pageNumber: number, pageCount: pdf.numPages });
        await yieldToBrowser();
        try {
          const page = await pdf.getPage(number);
          const viewport = page.getViewport({ scale: 1 });
          const scale = Math.min(2, 8192 / Math.max(viewport.width, viewport.height),
            Math.sqrt(11_900_000 / (viewport.width * viewport.height)));
          const image = await renderPdfPage(pdf, number, scale, { reference: true });
          signal?.throwIfAborted();
          const result = await scanPdfPage(image, { signal, onSeal: async (seal, frame) => {
            if (seen.has(seal)) return;
            seen.add(seal);
            await onSeal(seal, frame);
          } });
          if (result.seals.length) summary.pagesWithSeals++;
          else summary.missingPages.push(number);
          if (result.limited) summary.failedPages.push({ pageNumber: number, message: "QR scan limit reached" });
        } catch (error) {
          signal?.throwIfAborted();
          summary.failedPages.push({ pageNumber: number, message: error.message });
        }
      }
      summary.sealCount = seen.size;
      return summary;
    });
  } catch (error) {
    signal?.throwIfAborted();
    if (error.name === "PasswordException") throw new Error("This PDF requires a password. Open an unlocked copy to read its seals.", { cause: error });
    throw error;
  }
}

export function pdfScanSummary(result) {
  let text = `Found ${result.sealCount} QRed seal${result.sealCount === 1 ? "" : "s"} across ${result.pagesWithSeals} of ${result.pageCount} PDF pages.`;
  if (result.missingPages.length) text += ` No readable seal on PDF page(s): ${result.missingPages.join(", ")}.`;
  if (result.failedPages.length) text += ` Could not finish PDF page(s): ${result.failedPages.map(page => page.pageNumber).join(", ")}.`;
  return text;
}
