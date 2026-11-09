import { maskQrCode } from "../qr/maskQrCode.js";
import { scanQrImage } from "../qr/scanQrImage.js";
import { decodeSeal, qredPayloadFromPhotoScanResult, verifyQRedSeals } from "../qredVerifier.js";
import { scanPageAlignedImage } from "../qr/pageAlignedScan.js";
import { scanFooterSeals } from "../qr/footerSealScan.js";
import { qredPayloadFromScanResult } from "../qr/qrPayload.js";

const MAX_CODES_PER_PAGE = 64;
// An original 48 MP photo may remain in memory for trustworthy module
// sampling. Only the legacy QR-region fallback should use a reduced raster,
// otherwise that older path repeatedly allocates full-size image copies.
const MAX_LEGACY_SCAN_PIXELS = 8_000_000;
const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));


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

const LEGACY_DOWNSAMPLE_OFFSETS = [[0, 0], [-1, 0], [0, -1], [-1, -1]];

function boundedLegacyRaster(image) {
  const { width, height, data } = image;
  if (width * height <= MAX_LEGACY_SCAN_PIXELS) return image;
  const scale = Math.sqrt(MAX_LEGACY_SCAN_PIXELS / (width * height));
  const w = Math.max(1, Math.floor(width * scale));
  const h = Math.max(1, Math.floor(height * scale));
  const pixels = new Uint8ClampedArray(w * h * 4);
  // Average adjacent observations so downsizing conventional QR photos
  // doesn't throw away narrow module edges via nearest-neighbor aliasing.
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.round((y + 0.5) * height / h - 0.5));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.round((x + 0.5) * width / w - 0.5));
      const start = (y * w + x) * 4;
      for (const [dx, dy] of LEGACY_DOWNSAMPLE_OFFSETS) {
        const px = Math.max(0, sx + dx), py = Math.max(0, sy + dy);
        const src = (py * width + px) * 4;
        for (let c = 0; c < 3; c++) pixels[start + c] += data[src + c] * 0.25;
      }
      pixels[start + 3] = 255;
    }
  }
  return { data: pixels, width: w, height: h };
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
    const aligned = scanPageAlignedImage(image, { deep: !image.bounds });
    for (const { seal } of aligned) {
      if (!decodeSeal(seal) || seals.has(seal)) continue;
      seals.add(seal);
      await onSeal(seal, image);
      signal?.throwIfAborted();
    }
    // A complete one- or four-symbol page has nothing more to discover.
    // Incomplete page scans still try the historical region-based locator.
    if (!aligned.some(item => decodeSeal(item.seal)?.seal_sheet) &&
        (aligned.length === 4 || aligned.length === 1 && decodeSeal(aligned[0].seal)?.total_chunks === 1)) {
      return { seals: [...seals], limited: false };
    }
  }
  // A whole-sheet locator can cross two dense adjacent symbols. Isolate dark
  // QR regions before masking any of the original pixels in the legacy pass.
  if (image.bounds || !pageAligned) {
    const candidates = scanFooterSeals(image, { shouldContinue: () => !signal?.aborted });
    for (const code of candidates) {
      const seal = qredPayloadFromScanResult(code);
      if (!decodeSeal(seal)?.seal_sheet || seals.has(seal)) continue;
      seals.add(seal);
      await onSeal(seal, image);
      signal?.throwIfAborted();
    }
    if (seals.size === 4 && [...seals].every(seal => decodeSeal(seal).seal_sheet)) return { seals: [...seals], limited: false };
  }
  // Never clone and subdivide the full 12–48 MP original merely because the
  // page-aligned scan was incomplete. The legacy fallback operates on its own
  // bounded copy; collected seals still retain the ORIGINAL page photograph.
  const legacy = boundedLegacyRaster(image);
  const pixels = legacy === image ? new Uint8ClampedArray(image.data) : legacy.data;
  const regions = scanRegions(legacy.width, legacy.height);
  let codes = 0;
  for (let regionIndex = 0; regionIndex < regions.length; regionIndex++) {
    const region = regions[regionIndex];
    while (codes < MAX_CODES_PER_PAGE) {
      await yieldToBrowser();
      signal?.throwIfAborted();
      const data = regionPixels(pixels, legacy.width, region);
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
      if (!maskQrCode(pixels, legacy.width, legacy.height, code, region)) return { seals: [...seals], limited: true };
      // Removing an isolated code can make the remaining full-page geometry
      // readable. Revisit it before trying more small views.
      if (regionIndex > 0) { regionIndex = -1; break; }
    }
    if (codes === MAX_CODES_PER_PAGE) return { seals: [...seals], limited: true };
  }
  return { seals: [...seals], limited: false };
}

export async function scanPdfSeals(file, { onSeal = () => {}, onOriginalPage, onProgress = () => {}, signal } = {}) {
  signal?.throwIfAborted();
  const { withPdfDocument, renderPdfPage } = await import("../pdf/readPdfText.js");
  signal?.throwIfAborted();
  try {
    return await withPdfDocument(file, async pdf => {
      const seen = new Set();
      const sheetRecords = new Map();
      let firstSheet = Infinity;
      const summary = { pageCount: pdf.numPages, pagesWithSeals: 0, sealCount: 0, missingPages: [], failedPages: [] };
      async function pageImage(number) {
        const page = await pdf.getPage(number);
        const viewport = page.getViewport({ scale: 1 });
        const scale = Math.min(2, 8192 / Math.max(viewport.width, viewport.height),
          Math.sqrt(11_900_000 / (viewport.width * viewport.height)));
        return renderPdfPage(pdf, number, scale, { reference: true });
      }
      for (let number = 1; number <= pdf.numPages; number++) {
        signal?.throwIfAborted();
        onProgress({ pageNumber: number, pageCount: pdf.numPages });
        await yieldToBrowser();
        try {
          const image = await pageImage(number);
          signal?.throwIfAborted();
          const result = await scanPdfPage(image, { signal, onSeal: async (seal, frame) => {
            if (seen.has(seal)) return;
            seen.add(seal);
            const decoded = decodeSeal(seal);
            if (decoded.seal_sheet) {
              firstSheet = Math.min(firstSheet, number);
              const firstForRecord = !sheetRecords.has(decoded.document_id);
              sheetRecords.set(decoded.document_id, seal);
              await onSeal(seal, null, { replaceImage: firstForRecord });
            } else {
              await onSeal(seal, frame);
            }
          } });
          if (result.seals.length) summary.pagesWithSeals++;
          else summary.missingPages.push(number);
          if (result.limited) summary.failedPages.push({ pageNumber: number, message: "QR scan limit reached" });
        } catch (error) {
          signal?.throwIfAborted();
          summary.failedPages.push({ pageNumber: number, message: error.message });
        }
      }
      if (sheetRecords.size) {
        const groups = new Map();
        for (const seal of seen) {
          const id = decodeSeal(seal).document_id;
          if (!sheetRecords.has(id)) continue;
          if (!groups.has(id)) groups.set(id, []);
          groups.get(id).push(seal);
        }
        const originalPages = new Set();
        for (const [id, seals] of groups) {
          signal?.throwIfAborted();
          // Page numbers route the raster; the UI verifies with the recipient's
          // trusted key before allowing any text or visual comparison.
          const page = await verifyQRedSeals(seals);
          if (!["VALID", "UNVERIFIED"].includes(page.status) || !page.pdf || page.page_count >= firstSheet) continue;
          try {
            if (onOriginalPage) {
              const image = await pageImage(page.page_number);
              signal?.throwIfAborted();
              await onOriginalPage(sheetRecords.get(id), image);
            }
            originalPages.add(page.page_number);
          } catch (error) {
            signal?.throwIfAborted();
            summary.failedPages.push({ pageNumber: page.page_number, message: error.message });
          }
        }
        summary.originalPages = [...originalPages].sort((a, b) => a - b);
        summary.missingPages = summary.missingPages.filter(number => !originalPages.has(number));
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
  if (result.originalPages?.length) text += ` Seal sheets refer to original page(s): ${result.originalPages.join(", ")}.`;
  if (result.missingPages.length) text += ` No readable seal on PDF page(s): ${result.missingPages.join(", ")}.`;
  if (result.failedPages.length) text += ` Could not finish PDF page(s): ${result.failedPages.map(page => page.pageNumber).join(", ")}.`;
  return text;
}
