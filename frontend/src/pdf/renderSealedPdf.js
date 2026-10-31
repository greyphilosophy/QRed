import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { createQRedQrSymbol, qredQrPngDataUrl } from "../qredQr.js";
import { LEGAL_FOOTER_HEIGHT, resolvePageScalingStrategy, applyPageScaling, visiblePageGeometry } from "./pageScaling.js";
import { planQrStampLayout, planQrStampLayoutForFooterBand } from "./qrLayout.js";

export async function qrPngBytes(value) {
  const dataUrl = await qredQrPngDataUrl(value, { margin: 4, width: 360 });
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

// Placement only: no keys, signing callbacks, or mutable evidence plans.
export async function renderSealedPdf({ file, pageSealResults, pagesWithText, pageScalingStrategy = "automatic" }) {
  const tryWatermarks = pageScalingStrategy === "automatic" || pageScalingStrategy === "watermark";
  // A logo or embedded graphic does not make a text page unsuitable for a
  // watermark. Let placement and the rendered recovery check decide whether
  // that page needs a footer; image-only and blank pages still use one.
  const footerPages = tryWatermarks
    ? pagesWithText.flatMap((hasText, index) => !hasText ? [index + 1] : []) : [];
  // Only short reason labels are retained; never collect PDF text or scan data.
  const footerReasons = {};
  for (let index = 0; index < pagesWithText.length; index++) {
    if (!pagesWithText[index] && tryWatermarks) footerReasons[index + 1] = "This page has no extractable text.";
  }
  let plannedWatermarkLayout = null;
  if (tryWatermarks) {
    const watermarkPages = pagesWithText.map((_, index) => index).filter(index => !footerPages.includes(index + 1));
    if (watermarkPages.length) {
      const { planPdfWatermarks } = await import("./watermark.js");
      plannedWatermarkLayout = await planPdfWatermarks(file, pageSealResults, watermarkPages);
      for (const index of watermarkPages) if (!plannedWatermarkLayout[index]) {
        footerPages.push(index + 1);
        footerReasons[index + 1] = "No safe watermark position was found.";
      }
    }
  }
  async function renderAttempt() {
    const pdf = await PDFDocument.load(await file.arrayBuffer());
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const pages = pdf.getPages();
    if (pages.length !== pageSealResults.length) throw new Error("PDF page count changed while sealing");

    const PANEL_MARGIN = 18;
    const PANEL_PADDING = 10;
    const watermarkLayout = plannedWatermarkLayout?.map((layout, index) => footerPages.includes(index + 1) ? null : layout) ?? null;
    if (watermarkLayout?.some(Boolean)) {
      const { stampWatermarks } = await import("./watermark.js");
      await stampWatermarks(pdf, watermarkLayout, pageSealResults);
    }
    for (let pageIndex = pageSealResults.length - 1; pageIndex >= 0; pageIndex -= 1) {
      if (watermarkLayout?.[pageIndex]) continue;
      let page = pdf.getPage(pageIndex);
      const qrValues = pageSealResults[pageIndex].seals;
      const qrImages = await Promise.all(qrValues.map(async (value) => pdf.embedPng(await qrPngBytes(value))));
      const { width, height } = visiblePageGeometry(page);
      const resolvedPageScalingStrategy = resolvePageScalingStrategy(tryWatermarks ? "automatic" : pageScalingStrategy, width, height);
      const layout = resolvedPageScalingStrategy === "legal-footer"
        ? planQrStampLayoutForFooterBand(width, qrImages.length, { footerBandHeight: LEGAL_FOOTER_HEIGHT })
        : planQrStampLayout(width, qrImages.length);
      // Four dense v40 symbols can fit mathematically in a three-inch footer
      // while becoming too small to photograph. Never silently emit such a
      // fallback if the original-page 2x2 watermarks failed their preflight.
      const minModulePoints = Math.min(...qrValues.map(value =>
        layout.qrSize / (createQRedQrSymbol(value).modules.size + 8)));
      if (minModulePoints < 0.9) {
        throw new Error(`PDF page ${pageIndex + 1} has too many dense QR seals for a readable footer. Use a verified watermark layout or split this page's content.`);
      }
      const footerMargin = resolvedPageScalingStrategy === "legal-footer" ? 0 : PANEL_MARGIN;
      const footerHeight = resolvedPageScalingStrategy === "legal-footer" ? LEGAL_FOOTER_HEIGHT : footerMargin + layout.panelHeight;
      page = await applyPageScaling(pdf, pageIndex, page, resolvedPageScalingStrategy, footerHeight);
      page.drawRectangle({ x: footerMargin, y: footerMargin, width: layout.panelWidth, height: layout.panelHeight, color: rgb(1, 1, 1), opacity: 0.94 });
      const caption = "QRed sealed PDF page";
      const captionX = layout.labelBeside
        ? layout.qrOffsetX + layout.gridWidth + 12
        : footerMargin + PANEL_PADDING;
      // A crowded grid uses the full footer width; never draw a label over a QR
      // or its quiet zone merely to keep the decorative caption.
      if (!layout.labelBeside || captionX + font.widthOfTextAtSize(caption, 9) <= width - PANEL_MARGIN) {
        page.drawText(caption, {
          x: captionX,
          y: layout.labelBeside
            ? layout.qrOffsetY + (layout.gridHeight / 2)
            : footerMargin + layout.panelHeight - PANEL_PADDING - 9,
          size: 9,
          font,
          color: rgb(0.05, 0.12, 0.22),
        });
      }
      qrImages.forEach((image, index) => {
        const column = index % layout.columns;
        const row = Math.floor(index / layout.columns);
        const x = footerMargin + (layout.qrOffsetX ?? PANEL_PADDING) + (column * (layout.qrSize + layout.gap));
        const y = footerMargin + (layout.qrOffsetY ?? PANEL_PADDING) + ((layout.rows - row - 1) * (layout.qrSize + layout.gap));
        page.drawImage(image, { x, y, width: layout.qrSize, height: layout.qrSize });
      });
    }

    const sealedBytes = await pdf.save();
    let failed = [];
    const failureReasons = {};
    if (watermarkLayout?.some(Boolean)) {
      const { checkWatermarks } = await import("./watermark.js");
      failed = await checkWatermarks(sealedBytes, watermarkLayout, pageSealResults,
        { onFailure: (index, reason) => { failureReasons[index + 1] = reason; } });
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
      entryless = await planPdfWatermarks(file, pageSealResults, [0], { omitEntry: true });
    }
    const needAlternative = rendered.failed.filter(index =>
      !entryless?.[index] && !triedAlternative.has(index));
    for (const index of needAlternative) triedAlternative.add(index);
    let alternatives = null;
    if (needAlternative.length) {
      const { planPdfWatermarks } = await import("./watermark.js");
      alternatives = await planPdfWatermarks(file, pageSealResults, needAlternative, {
        excludedLayouts: plannedWatermarkLayout,
        omitEntry: needAlternative.includes(0) && !plannedWatermarkLayout[0]?.entry,
      });
    }
    for (const index of rendered.failed) {
      if (entryless?.[index]) {
        plannedWatermarkLayout[index] = entryless[index];
      } else if (alternatives?.[index]) {
        plannedWatermarkLayout[index] = alternatives[index];
      } else if (!footerPages.includes(index + 1)) {
        footerPages.push(index + 1);
        footerReasons[index + 1] = rendered.failureReasons[index + 1] ?? "The watermark did not pass verification.";
      }
    }
  } while (rendered.failed.length);
  // An entry-free watermark may be perfectly readable even though the
  // first watermark+entry geometry failed. The old retry algorithm stopped
  // here, losing the navigation code despite ample space elsewhere.
  //
  // After the *signed watermark* passes, reuse its geometry and search the
  // original page for a non-overlapping navigation code. Accept the combined
  // layout only if the complete, unchanged signed payload AND entry QR pass
  // exactly the same preflight as every other watermark layout.
  if (rendered.watermarkLayout?.[0] && !rendered.watermarkLayout[0].entry) {
    const { findEntryForWatermark } = await import("./watermark.js");
    const prior = plannedWatermarkLayout[0];
    const entry = await findEntryForWatermark(file, prior.boxes);
    if (entry) {
      plannedWatermarkLayout[0] = { ...prior, entry };
      try {
        const withEntry = await renderAttempt();
        if (!withEntry.failed.length) rendered = withEntry;
        else plannedWatermarkLayout[0] = prior;
      } catch {
        // The navigational QR is optional: never discard a validated signed
        // watermark because an optional follow-up render cannot complete.
        plannedWatermarkLayout[0] = prior;
      }
    }
  }
  const { sealedBytes, watermarkLayout } = rendered;
  footerPages.sort((a, b) => a - b);
  return { blob: new Blob([sealedBytes], { type: "application/pdf" }), watermarkLayout, footerPages, footerReasons };
}
