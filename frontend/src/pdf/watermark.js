import { rgb, StandardFonts } from "pdf-lib";
import { createQRedQrSymbol } from "../qredQr.js";
import { scanQrImage } from "../qr/scanQrImage.js";
import { DEFAULT_WATERMARK_MARGIN_POINTS, pageWatermarkRegions, scanPageAlignedImage } from "../qr/pageAlignedScan.js";
import { qredPayloadFromScanResult } from "../qr/qrPayload.js";
import { renderPdfPage, withPdfDocument } from "./readPdfText.js";
import { planWatermarks, watermarkMarginForPage } from "./watermarkPlacement.js";
import { scanAllSealsFromPage, scanFramedSealFromPage, simulatePrintPhoto } from "./watermarkPreflight.js";

export { planWatermarks } from "./watermarkPlacement.js";

export { ENTRY_URL, ENTRY_QR_SIZE, createEntryQrSymbol } from "./navigationQr.js";
import { ENTRY_URL, ENTRY_QR_SIZE, createEntryQrSymbol } from "./navigationQr.js";
import { drawQrSymbol } from "./qrDrawing.js";

// Fifteen-percent black survives more printer gray-tone loss than the old 6%.
// Keep it pale enough to preserve the readability of underlying black text.
export const WATERMARK_GRAY = 0.85;
const MARGIN = DEFAULT_WATERMARK_MARGIN_POINTS;
const ENTRY_WIDTH = 70, ENTRY_HEIGHT = 52;

// Count every visible nonwhite pixel, including graphics and annotations.
// Never infer empty space from extracted text alone.
export function findEntryPlacement(image, { avoidBoxes = [], textOnly = false } = {}) {
  const { data, width, height, scale, bounds } = image;
  const entryHeight = textOnly ? 14 : ENTRY_HEIGHT;
  // Text needs no white backing. A uniform pale paper background can remain
  // intact beneath it; darker or differently colored source marks stay clear.
  const background = Array.from(data.subarray(0, 3));
  const paleBackground = textOnly && background.every(channel => channel >= 230);
  const stride = width + 1;
  const ink = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const matchesBackground = paleBackground && background.every((channel, c) => Math.abs(data[i + c] - channel) <= 1);
      if (Math.min(data[i], data[i + 1], data[i + 2]) < 250 && !matchesBackground) row++;
      ink[(y + 1) * stride + x + 1] = ink[y * stride + x + 1] + row;
    }
  }
  // Bottom first, then top, then work inward. Favor the right corner so the
  // small navigation code usually stays outside the main body of the page.
  const ys = new Set([MARGIN, bounds.height - MARGIN - entryHeight]);
  for (let y = MARGIN; y <= bounds.height - MARGIN - entryHeight; y += 6) ys.add(y);
  for (const y of ys) {
    for (let x = bounds.width - MARGIN - ENTRY_WIDTH; x >= MARGIN; x -= 6) {
      if (y < MARGIN) continue;
      const left = Math.max(0, Math.floor((x - 3) * scale));
      const right = Math.min(width, Math.ceil((x + ENTRY_WIDTH + 3) * scale));
      const top = Math.max(0, Math.floor((bounds.height - y - entryHeight - 3) * scale));
      const bottom = Math.min(height, Math.ceil((bounds.height - y + 3) * scale));
      if (ink[bottom * stride + right] - ink[top * stride + right]
          - ink[bottom * stride + left] + ink[top * stride + left] !== 0) continue;
      const candidate = { x: bounds.x + x, y: bounds.y + y, width: ENTRY_WIDTH, height: entryHeight };
      // Caller-supplied keepouts protect legacy square watermarks and their
      // quiet zones. Full-page overlays instead rely on combined preflight.
      // Match the first-pass planner's 8-point entry clearance.
      const clearance = 8;
      if (avoidBoxes.some(box =>
        candidate.x < box.x + box.width + clearance && candidate.x + candidate.width > box.x - clearance &&
        candidate.y < box.y + box.height + clearance && candidate.y + candidate.height > box.y - clearance)) continue;
      return candidate;
    }
  }
  throw new Error("No clear space on the first page for the small qred.org code. Choose a footer layout or provide a PDF with a blank area at least 1.1 by 0.8 inches.");
}

// Once the actual signed QR geometry has passed preflight, look for a clear
// navigation-code position on the original page. Page-aligned watermarks may
// be covered by the optional entry panel, but the combined render must still
// pass exact-payload preflight. Legacy squares retain their quiet zones.
export async function findEntryForWatermark(file, boxes, { pageAligned = false, textOnly = false } = {}) {
  if (!boxes?.length) return null;
  return withPdfDocument(file, async (pdf) => {
    const page = await pdf.getPage(1);
    const supported = page.userUnit === 1 &&
      page.getViewport({ scale: 2, rotation: 0 }).width *
      page.getViewport({ scale: 2, rotation: 0 }).height <= 12_000_000;
    if (!supported) { page.cleanup(); return null; }
    const image = await renderPdfPage(pdf, 1);
    try { return findEntryPlacement(image, { avoidBoxes: pageAligned ? [] : boxes, textOnly }); }
    catch { return null; }
  });
}

async function documentWatermarkMargin(source) {
  // Choose from the whole original document, even when planning only a subset
  // of its pages during a retry. A later narrow-margin page must also enlarge
  // earlier full-page watermarks. Discard each raster before reading the next.
  for (let number = 1; number <= source.numPages; number++) {
    const page = await source.getPage(number);
    const viewport = page.getViewport({ scale: 2, rotation: 0 });
    if (page.userUnit !== 1 || viewport.width * viewport.height > 12_000_000) {
      page.cleanup();
      continue;
    }
    const margin = watermarkMarginForPage(await renderPdfPage(source, number));
    if (margin < DEFAULT_WATERMARK_MARGIN_POINTS) return margin;
  }
  return DEFAULT_WATERMARK_MARGIN_POINTS;
}

export async function planPdfWatermarks(file, pageSealResults, pageIndices = pageSealResults.map((_, index) => index),
  { excludedLayouts = null, omitEntry = false } = {}) {
  const layouts = new Array(pageSealResults.length).fill(null);
  await withPdfDocument(file, async (source) => {
    // Legacy square retries do not use the page-aligned margin profile.
    const marginPoints = pageIndices.some(index => !excludedLayouts?.[index])
      ? await documentWatermarkMargin(source) : DEFAULT_WATERMARK_MARGIN_POINTS;
    for (const index of pageIndices) {
      const seals = pageSealResults[index].seals;
      if (seals.length > 4) throw new Error(`Page ${index + 1} needs too many watermarks. Choose a footer layout.`);
      const sourcePage = await source.getPage(index + 1);
      if (sourcePage.userUnit !== 1) { sourcePage.cleanup(); continue; }
      const viewport = sourcePage.getViewport({ scale: 2, rotation: 0 });
      if (viewport.width * viewport.height > 12_000_000) { sourcePage.cleanup(); continue; }
      const image = await renderPdfPage(source, index + 1);
      const symbols = seals.map(value => createQRedQrSymbol(value));
      const previous = excludedLayouts?.[index];
      // A failed full-page grid contains every possible fallback square.
      // Its footprint must not exclude those candidates; overlap exclusion
      // applies only when retrying another content-avoiding square layout.
      const options = { excludeBoxes: previous?.pageAligned ? null : previous?.boxes ?? null,
        marginPoints };
      let boxes = null, pageAligned = false;
      // Establish a readable full-page grid first. Navigation is added as a
      // separately verified overlay after the signed watermark passes.
      if (!previous && (symbols.length === 1 || symbols.length === 4)) {
        try {
          const proposed = planWatermarks(image, symbols, null, options);
          // Only the standardized page-relative geometry can be decoded
          // without the signer sharing its placement. Four *legacy squares*
          // must not be mislabeled as four aligned quadrants.
          const standard = pageWatermarkRegions(symbols.length, image.bounds, options).map(region => ({
            x: image.bounds.x + region.x * image.bounds.width,
            y: image.bounds.y + (1 - region.y - region.height) * image.bounds.height,
            width: region.width * image.bounds.width,
            height: region.height * image.bounds.height,
          }));
          const aligned = proposed.length === standard.length && proposed.every((box, i) =>
            ["x", "y", "width", "height"].every(key => Math.abs(box[key] - standard[i][key]) <= 0.05));
          if (aligned) { boxes = proposed; pageAligned = true; }
        } catch { /* Try the content-avoiding legacy layout below. */ }
      }
      let entry = null;
      if (!boxes) {
        if (index === 0 && !omitEntry) {
          try { entry = findEntryPlacement(image); } catch { /* Optional navigation only. */ }
        }
        try { boxes = planWatermarks(image, symbols, entry, { ...options, preferPageAligned: false }); }
        catch {
          if (entry) {
            try { boxes = planWatermarks(image, symbols, null, { ...options, preferPageAligned: false }); entry = null; }
            catch { /* Safe footer fallback. */ }
          }
        }
      }
      if (boxes) layouts[index] = { boxes, ...(pageAligned ? { pageAligned: true } : {}), ...(entry ? { entry } : {}) };
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
      drawQrSymbol(pdf.getPage(index), createQRedQrSymbol(value), layouts[index].boxes[part], WATERMARK_GRAY, true,
        Boolean(layouts[index].pageAligned));
    });
  }
  const entry = layouts[0]?.entry;
  if (entry) {
    const page = pdf.getPage(0);
    // The box was checked against the original page: its white backing never
    // covers source content. On a full-page layout it may cover watermark
    // modules only if the resulting signed payload still passes preflight.
    page.drawRectangle({ ...entry, color: rgb(1, 1, 1) });
    // Corner brackets frame the navigation target outside its QR quiet zone.
    for (const [left, bottom] of [[true, true], [true, false], [false, true], [false, false]]) {
      const x = entry.x + (left ? 1 : entry.width - 1);
      const y = entry.y + (bottom ? 1 : entry.height - 1);
      const start = { x, y };
      page.drawLine({ start, end: { x: x + (left ? 6 : -6), y }, thickness: 0.6, color: rgb(0, 0, 0) });
      page.drawLine({ start, end: { x, y: y + (bottom ? 6 : -6) }, thickness: 0.6, color: rgb(0, 0, 0) });
    }
    drawQrSymbol(page, createEntryQrSymbol(),
      { x: entry.x + (entry.width - ENTRY_QR_SIZE) / 2, y: entry.y + 12, width: ENTRY_QR_SIZE, height: ENTRY_QR_SIZE }, 0);
  }
  const captionBox = entry ?? layouts[0]?.entryText;
  if (captionBox) {
    const page = pdf.getPage(0);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const caption = "Verify at qred.org";
    const size = entry ? 7 : 8;
    page.drawText(caption, { x: captionBox.x + (captionBox.width - font.widthOfTextAtSize(caption, size)) / 2,
      y: captionBox.y + 3, size, font, color: rgb(0, 0, 0) });
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
export async function checkWatermarks(bytes, layouts, pageSealResults, { onFailure = null } = {}) {
  const failed = new Set();
  const fail = (index, reason) => {
    if (failed.has(index)) return;
    failed.add(index);
    onFailure?.(index, reason);
  };
  await withPdfDocument(new Blob([bytes], { type: "application/pdf" }), async (pdf) => {
    for (let index = 0; index < layouts.length; index++) {
      if (!layouts[index]) continue;
      const image = await renderPdfPage(pdf, index + 1);
      if (layouts[index].entry) {
        const qr = crop(image, layouts[index].entry);
        const photo = simulatePrintPhoto(qr);
        if ([qr, photo].some(sample => scanQrImage(sample.data, sample.width, sample.height,
          { tryWatermark: false })?.data !== ENTRY_URL)) {
          fail(index, "The small verification-link QR could not be read.");
        }
      }
      if (layouts[index].pageAligned) {
        // Verify a REAL full-page raster, not saved placement metadata. The
        // same standalone image decoder is used by photographed paper. Also
        // simulate printer/camera degradation at the page rather than crop.
        const expected = pageSealResults[index].seals;
        const observed = scanPageAlignedImage(image).map(result => result.seal);
        const degraded = { ...simulatePrintPhoto(image), bounds: image.bounds, scale: image.scale };
        const softened = scanPageAlignedImage(degraded).map(result => result.seal);
        if (!expected.every(value => observed.includes(value)) ||
            !expected.every(value => softened.includes(value))) {
          fail(index, "The page-aligned watermark could not be recovered from the complete rendered page.");
        }
        continue;
      }
      for (let part = 0; part < layouts[index].boxes.length; part++) {
        const qr = crop(image, layouts[index].boxes[part]);
        const code = scanQrImage(qr.data, qr.width, qr.height,
          { tryRescaling: false, maxAttempts: 3 });
        const expected = pageSealResults[index].seals[part];
        if (qredPayloadFromScanResult(code) !== expected) {
          fail(index, "The seal could not be read in the clean PDF.");
          break;
        }
        // A clean PDF render is too forgiving. Check a softened, slightly
        // shaded print-like image and require the complete signed payload.
        const photo = simulatePrintPhoto(qr);
        if (qredPayloadFromScanResult(scanQrImage(photo.data, photo.width, photo.height,
          { tryRescaling: false, maxAttempts: 3 })) !== expected) {
          fail(index, "The seal did not survive the simulated print test.");
          break;
        }
      }
      // A known-position crop is easier to decode than a photographed sheet.
      // Require the verifier to locate *every* seal on the full page as well.
      if (!failed.has(index) && !scanAllSealsFromPage(image, pageSealResults[index].seals,
        { entry: layouts[index].entry })) {
        // Full-page discovery is useful, but not mandatory: a person can
        // frame the pale watermark more closely with a phone camera.
        // A 40%-wider field of view still requires independent QR location,
        // and every code must yield its *exact* signed byte payload.
        const framedReadable = layouts[index].boxes.every((box, part) =>
          scanFramedSealFromPage(image, box, pageSealResults[index].seals[part],
            { entry: layouts[index].entry }));
        if (!framedReadable) fail(index, "The seal could not be located in a camera-framed view.");
      }
    }
  });
  return [...failed];
}
