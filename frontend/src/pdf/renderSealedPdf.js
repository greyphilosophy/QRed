import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { qredQrPngDataUrl } from "../qredQr.js";
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
  let plannedWatermarkLayout = null;
  if (tryWatermarks) {
    const watermarkPages = pagesWithText.map((_, index) => index).filter(index => !footerPages.includes(index + 1));
    if (watermarkPages.length) {
      const { planPdfWatermarks } = await import("./watermark.js");
      plannedWatermarkLayout = await planPdfWatermarks(file, pageSealResults, watermarkPages);
      for (const index of watermarkPages) if (!plannedWatermarkLayout[index]) footerPages.push(index + 1);
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
    if (watermarkLayout?.some(Boolean)) {
      const { checkWatermarks } = await import("./watermark.js");
      failed = await checkWatermarks(sealedBytes, watermarkLayout, pageSealResults);
    }
    return { sealedBytes, watermarkLayout, failed };
  }
  // Give a failed watermark one distinct placement before sacrificing the
  // original page size for a footer. Both candidates must pass every check.
  const triedAlternative = new Set();
  let rendered;
  do {
    rendered = await renderAttempt();
    const needAlternative = rendered.failed.filter(index => !triedAlternative.has(index));
    for (const index of needAlternative) triedAlternative.add(index);
    let alternatives = null;
    if (needAlternative.length) {
      const { planPdfWatermarks } = await import("./watermark.js");
      alternatives = await planPdfWatermarks(file, pageSealResults, needAlternative,
        { excludedLayouts: plannedWatermarkLayout });
    }
    for (const index of rendered.failed) {
      if (alternatives?.[index]) {
        plannedWatermarkLayout[index] = alternatives[index];
      } else if (!footerPages.includes(index + 1)) {
        footerPages.push(index + 1);
      }
    }
  } while (rendered.failed.length);
  const { sealedBytes, watermarkLayout } = rendered;
  footerPages.sort((a, b) => a - b);
  return { blob: new Blob([sealedBytes], { type: "application/pdf" }), watermarkLayout, footerPages };
}
