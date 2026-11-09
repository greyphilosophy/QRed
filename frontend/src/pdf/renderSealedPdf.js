import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { MAX_PDF_SEALS } from "../sealBudget.js";
import { sealSheetString } from "../sealFormat.js";
import { createQRedQrSymbol, qredQrPngDataUrl } from "../qredQr.js";
import { resolvePageScalingStrategy, applyPageScaling, visiblePageGeometry } from "./pageScaling.js";
import { planFooterLayout } from "./qrLayout.js";
import { createEntryQrSymbol } from "./navigationQr.js";
import { drawQrSymbol } from "./qrDrawing.js";
import { appendSealSheets, usesSealSheets, usesWatermarks } from "./sealSheets.js";

// Recheck each smaller placement on a fresh original. Never leave failed QR
// ink behind or append a duplicate of a piece that passed on the original.
async function partialWatermark(file, records, index, recovered) {
  const { planPdfWatermarks, stampWatermarks, checkWatermarks } = await import("./watermark.js");
  const seals = records[index].seals;
  async function tryParts(parts, knownLayout) {
    const trial = records.slice();
    trial[index] = { seals: parts.map(part => seals[part]) };
    let layouts;
    if (knownLayout) {
      layouts = new Array(records.length).fill(null);
      layouts[index] = { ...knownLayout, boxes: parts.map(part => knownLayout.boxes[part]) };
    } else {
      layouts = await planPdfWatermarks(file, trial, [index], { omitEntry: true });
    }
    if (!layouts[index]) return null;
    const pdf = await PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
    await stampWatermarks(pdf, layouts, trial);
    const bytes = await pdf.save({ updateFieldAppearances: false });
    const failed = await checkWatermarks(bytes, layouts, trial);
    return failed.length ? null : { parts, layout: layouts[index], record: trial[index] };
  }
  for (let count = seals.length - 1; count > 0; count--) {
    if (recovered?.parts.length === count) {
      const retained = await tryParts(recovered.parts, recovered.layout);
      if (retained) return retained;
    }
    const placed = await tryParts(Array.from({ length: count }, (_, part) => part));
    if (placed) return placed;
  }
  return null;
}

async function finishWithSheets(bytes, records, onPageParts, watermarkLayout) {
  const entries = [];
  const pageSealStrings = records.map(({ seals }, index) => seals.map((original, part) => {
    if (onPageParts[index].includes(part)) return original;
    const seal = sealSheetString(original);
    entries.push({ pageNumber: index + 1, part, total: seals.length, seal });
    return seal;
  }));
  const { bytes: output, sheetCount } = await appendSealSheets(bytes, entries, records.length);
  return { blob: new Blob([output], { type: "application/pdf" }), watermarkLayout, pageSealStrings,
    sheetCount, sheetPages: [...new Set(entries.map(entry => entry.pageNumber))], footerPages: [], footerReasons: {} };
}

export async function qrPngBytes(value) {
  const dataUrl = await qredQrPngDataUrl(value, { margin: 4, width: 360 });
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

// Placement only: no keys, signing callbacks, or mutable evidence plans.
export async function renderSealedPdf({ file, pageSealResults, pagesWithText, pageScalingStrategy = "automatic" }) {
  const sheets = usesSealSheets(pageScalingStrategy);
  if (pageScalingStrategy === "seal-sheets") {
    return finishWithSheets(await file.arrayBuffer(), pageSealResults, pageSealResults.map(() => []), null);
  }
  const tryWatermarks = usesWatermarks(pageScalingStrategy);
  const watermarkRecords = sheets ? pageSealResults.map(({ seals }) => ({ seals: seals.slice(0, MAX_PDF_SEALS) })) : pageSealResults;
  const recovered = new Map();
  // A logo or embedded graphic does not make a text page unsuitable for a
  // watermark. Let placement and the rendered recovery check decide whether
  // that page needs a footer; image-only and blank pages still use one.
  const fallbackPages = tryWatermarks
    ? pagesWithText.flatMap((hasText, index) => !hasText ? [index + 1] : []) : [];
  // Only short reason labels are retained; never collect PDF text or scan data.
  const fallbackReasons = {};
  for (let index = 0; index < pagesWithText.length; index++) {
    if (!pagesWithText[index] && tryWatermarks) fallbackReasons[index + 1] = "This page has no extractable text.";
  }
  let plannedWatermarkLayout = null;
  if (tryWatermarks) {
    const watermarkPages = pagesWithText.map((_, index) => index).filter(index => !fallbackPages.includes(index + 1));
    if (watermarkPages.length) {
      const { planPdfWatermarks } = await import("./watermark.js");
      plannedWatermarkLayout = await planPdfWatermarks(file, watermarkRecords, watermarkPages);
      for (const index of watermarkPages) if (!plannedWatermarkLayout[index]) {
        fallbackPages.push(index + 1);
        fallbackReasons[index + 1] = "No safe watermark position was found.";
      }
    }
  }
  async function renderAttempt() {
    const pdf = await PDFDocument.load(await file.arrayBuffer(), { updateMetadata: false });
    const font = sheets ? null : await pdf.embedFont(StandardFonts.Helvetica);
    const pages = pdf.getPages();
    if (pages.length !== pageSealResults.length) throw new Error("PDF page count changed while sealing");

    const PANEL_PADDING = 10;
    const watermarkLayout = plannedWatermarkLayout?.map((layout, index) => fallbackPages.includes(index + 1) ? null : layout) ?? null;
    if (watermarkLayout?.some(Boolean)) {
      const { stampWatermarks } = await import("./watermark.js");
      await stampWatermarks(pdf, watermarkLayout, watermarkRecords);
    }
    for (let pageIndex = pageSealResults.length - 1; pageIndex >= 0; pageIndex -= 1) {
      if (sheets || watermarkLayout?.[pageIndex]) continue;
      let page = pdf.getPage(pageIndex);
      const qrValues = pageSealResults[pageIndex].seals;
      const qrImages = await Promise.all(qrValues.map(async (value) => pdf.embedPng(await qrPngBytes(value))));
      const { width, height } = visiblePageGeometry(page);
      const resolvedPageScalingStrategy = resolvePageScalingStrategy(tryWatermarks ? "automatic" : pageScalingStrategy, width, height);
      const caption = "Verify at qred.org";
      const layout = planFooterLayout(width, qrImages.length, {
        legal: resolvedPageScalingStrategy === "legal-footer", navigation: pageIndex === 0,
        captionWidth: font.widthOfTextAtSize(caption, 9),
      });
      // Four dense v40 symbols can fit mathematically in a three-inch footer
      // while becoming too small to photograph. Never silently emit such a
      // fallback if the original-page 2x2 watermarks failed their preflight.
      const minModulePoints = Math.min(...qrValues.map(value =>
        layout.qrSize / (createQRedQrSymbol(value).modules.size + 8)));
      if (minModulePoints < 0.9) {
        throw new Error(`PDF page ${pageIndex + 1} has too many dense QR seals for a readable footer. Use a verified watermark layout or split this page's content.`);
      }
      const { footerMargin, footerHeight } = layout;
      page = await applyPageScaling(pdf, pageIndex, page, resolvedPageScalingStrategy, footerHeight);
      page.drawRectangle({ x: footerMargin, y: footerMargin, width: layout.panelWidth, height: layout.panelHeight, color: rgb(1, 1, 1), opacity: 0.94 });
      page.drawText(caption, { ...layout.caption, size: 9, font, color: rgb(0.05, 0.12, 0.22) });
      if (layout.entry) drawQrSymbol(page, createEntryQrSymbol(), layout.entry, 0);
      qrImages.forEach((image, index) => {
        const column = index % layout.columns;
        const row = Math.floor(index / layout.columns);
        const x = footerMargin + (layout.qrOffsetX ?? PANEL_PADDING) + (column * (layout.qrSize + layout.gap));
        const y = footerMargin + (layout.qrOffsetY ?? PANEL_PADDING) + ((layout.rows - row - 1) * (layout.qrSize + layout.gap));
        page.drawImage(image, { x, y, width: layout.qrSize, height: layout.qrSize });
      });
    }

    const sealedBytes = await pdf.save({ updateFieldAppearances: false });
    let failed = [];
    const failureReasons = {};
    if (watermarkLayout?.some(Boolean)) {
      const { checkWatermarks } = await import("./watermark.js");
      failed = await checkWatermarks(sealedBytes, watermarkLayout, watermarkRecords, {
        onFailure: (index, reason) => { failureReasons[index + 1] = reason; },
        onPartial: sheets ? (index, parts, layout) => {
          if (parts.length > (recovered.get(index)?.parts.length || 0)) recovered.set(index, { parts, layout });
        } : null,
      });
    }
    return { sealedBytes, watermarkLayout, failed, failureReasons };
  }
  // Give a failed watermark one distinct placement before sacrificing the
  // original page size for a footer. Both candidates must pass every check.
  const triedAlternative = new Set();
  let triedWithoutEntry = false;
  let rendered;
  do {
    rendered = await renderAttempt();
    // If the first-page navigation QR interferes with signed-payload recovery,
    // remove it before trying another placement or extending the page.
    let entryless = null;
    const dropEntry = !triedWithoutEntry && rendered.failed.includes(0)
      && Boolean(plannedWatermarkLayout?.[0]?.entry);
    if (dropEntry) {
      triedWithoutEntry = true;
      const { planPdfWatermarks } = await import("./watermark.js");
      entryless = await planPdfWatermarks(file, watermarkRecords, [0], { omitEntry: true });
    }
    const needAlternative = rendered.failed.filter(index =>
      !entryless?.[index] && !triedAlternative.has(index));
    for (const index of needAlternative) triedAlternative.add(index);
    let alternatives = null;
    if (needAlternative.length) {
      const { planPdfWatermarks } = await import("./watermark.js");
      alternatives = await planPdfWatermarks(file, watermarkRecords, needAlternative, {
        excludedLayouts: plannedWatermarkLayout,
        omitEntry: needAlternative.includes(0) && !plannedWatermarkLayout[0]?.entry,
      });
    }
    for (const index of rendered.failed) {
      if (entryless?.[index]) {
        plannedWatermarkLayout[index] = entryless[index];
      } else if (alternatives?.[index]) {
        plannedWatermarkLayout[index] = alternatives[index];
      } else if (!fallbackPages.includes(index + 1)) {
        fallbackPages.push(index + 1);
        fallbackReasons[index + 1] = rendered.failureReasons[index + 1] ?? "The watermark did not pass verification.";
      }
    }
  } while (rendered.failed.length);
  // An entry-free watermark may be perfectly readable even though the
  // first watermark+entry geometry failed. The old retry algorithm stopped
  // here, losing the navigation code despite ample space elsewhere.
  //
  // After the *signed watermark* passes, reuse its geometry and search the
  // original page for a navigation code. It may overlap full-page watermark
  // modules, but never original ink or legacy square quiet zones. Accept it
  // only if the complete, unchanged signed payload AND entry QR pass
  // preflight. If the QR cannot stay, try a smaller text-only instruction.
  if (rendered.watermarkLayout?.[0] && !rendered.watermarkLayout[0].entry) {
    const { findEntryForWatermark } = await import("./watermark.js");
    const prior = plannedWatermarkLayout[0];
    for (const textOnly of [false, true]) {
      const entry = await findEntryForWatermark(file, prior.boxes, { pageAligned: prior.pageAligned, textOnly });
      if (!entry) continue;
      plannedWatermarkLayout[0] = { ...prior, [textOnly ? "entryText" : "entry"]: entry };
      try {
        const withEntry = await renderAttempt();
        if (!withEntry.failed.length) { rendered = withEntry; break; }
      } catch {
        // A failed QR can still leave a smaller readable text instruction.
      }
      plannedWatermarkLayout[0] = prior;
    }
    if (!sheets && !rendered.watermarkLayout[0].entry && !rendered.watermarkLayout[0].entryText) {
      // The instruction is mandatory. If even text cannot fit safely, use
      // the standard footer, which reserves space for the same caption.
      fallbackPages.push(1);
      fallbackReasons[1] = "No readable position was available for the verification instruction.";
      rendered = await renderAttempt();
      if (rendered.failed.length) throw new Error("The sealed PDF could not retain readable verification instructions and watermarks.");
    }
  }
  if (sheets) {
    const onPageParts = watermarkRecords.map(({ seals }, index) =>
      rendered.watermarkLayout?.[index] ? seals.map((_, part) => part) : []);
    let restored = false;
    for (const number of [...fallbackPages]) {
      const index = number - 1;
      if (!pagesWithText[index] || pageSealResults[index].seals.length < 2) continue;
      const partial = await partialWatermark(file, watermarkRecords, index, recovered.get(index));
      if (!partial) continue;
      onPageParts[index] = partial.parts;
      watermarkRecords[index] = partial.record;
      plannedWatermarkLayout[index] = partial.layout;
      fallbackPages.splice(fallbackPages.indexOf(number), 1);
      restored = true;
    }
    if (restored) {
      rendered = await renderAttempt();
      if (rendered.failed.length) throw new Error("The final partial watermarks could not be verified.");
    }
    return finishWithSheets(rendered.sealedBytes, pageSealResults, onPageParts, rendered.watermarkLayout);
  }
  const { sealedBytes, watermarkLayout } = rendered;
  fallbackPages.sort((a, b) => a - b);
  return { blob: new Blob([sealedBytes], { type: "application/pdf" }), watermarkLayout, footerPages: fallbackPages, footerReasons: fallbackReasons };
}
