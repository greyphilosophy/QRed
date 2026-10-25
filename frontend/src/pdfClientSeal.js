import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { createQRedSeals, DEFAULT_BOOTSTRAP_URL } from "./qredSealer.js";
import { qredQrPngDataUrl } from "./qredQr.js";
import { LEGAL_FOOTER_HEIGHT, LEGAL_PAGE_HEIGHT, resolvePageScalingStrategy, applyPageScaling, visiblePageGeometry } from "./pdf/pageScaling.js";
import { QR_SIZE, planQrStampLayout, planQrStampLayoutForFooterBand } from "./pdf/qrLayout.js";
import { planPageEvidence } from "./pdf/pageEvidencePlan.js";
import { flattenPdfForSealing } from "./pdf/flattenPdf.js";

export { QR_SIZE, LEGAL_PAGE_HEIGHT, LEGAL_FOOTER_HEIGHT };
export { planQrStampLayout, planQrStampLayoutForFooterBand };

async function extractPdfPageTexts(file) {
  const { extractPdfPageTexts: readPages } = await import("./pdf/readPdfText.js");
  return readPages(file);
}

export async function extractPdfText(file) {
  return extractPdfPageTexts(file).then((pages) => pages.join("\n\n").trim());
}

async function sha256Hex(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function pageContentHash(body) { return sha256Hex(body); }

async function documentMerkleRoot(pageTexts) {
  const leaves = await Promise.all(pageTexts.map((pageText) => pageContentHash(pageText)));
  if (leaves.length === 0) return sha256Hex(new Uint8Array());
  let level = leaves;
  while (level.length > 1) {
    const nextLevel = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      nextLevel.push(await sha256Hex(`${left}${right}`));
    }
    level = nextLevel;
  }
  return level[0];
}

async function createPageSealResults({ file, privateKey, publicKey, bootstrapUrl, encodingStrategy, attestPages }) {
  const { readPdfPagesWithEvidence } = await import("./pdf/readPdfText.js");
  const plans = await readPdfPagesWithEvidence(file, page => planPageEvidence(page, {
    google: Boolean(attestPages), multiple: page.pageCount > 1, encodingStrategy,
  }));
  const merkleRoot = await documentMerkleRoot(plans.map(page => page.body));
  const timestamp = new Date().toISOString();
  const contexts = plans.map((_, index) => ({ pageNumber: index + 1, pageCount: plans.length, documentRoot: merkleRoot }));
  const attestations = attestPages ? await attestPages(plans.map((page, index) => ({
    content: page.body, metadata: { pdf: true, ...(page.pageEvidence ? { page_evidence: true } : {}), page_number: index + 1,
      page_count: plans.length, document_root: plans.length > 1 ? merkleRoot : null },
  }))) : null;
  if (attestations && attestations.length !== plans.length) throw new Error("Missing page attestations");
  const results = await Promise.all(plans.map(async (page, index) => createQRedSeals({
    content: page.text, pageEvidence: page.pageEvidence, privateKey, publicKey, bootstrapUrl, encodingStrategy, timestamp,
    pageContext: contexts[index], attestation: attestations?.[index],
  })));
  return { results, plans };
}

export async function qrPngBytes(value) {
  const dataUrl = await qredQrPngDataUrl(value, { margin: 4, width: 360 });
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function sealPdfInBrowser({ file, privateKey, publicKey, attestPages, bootstrapUrl = DEFAULT_BOOTSTRAP_URL, encodingStrategy = "automatic", pageScalingStrategy = "automatic" }) {
  const prepared = await flattenPdfForSealing(file);
  file = prepared.file;
  const { results: pageSealResults, plans } = await createPageSealResults({ file, privateKey, publicKey, bootstrapUrl, encodingStrategy, attestPages });
  const tryWatermarks = pageScalingStrategy === "automatic" || pageScalingStrategy === "watermark";
  // A logo or embedded graphic does not make a text page unsuitable for a
  // watermark. Let placement and the rendered recovery check decide whether
  // that page needs a footer; image-only and blank pages still use one.
  const footerPages = tryWatermarks
    ? plans.flatMap((page, index) => !page.text ? [index + 1] : []) : [];
  let plannedWatermarkLayout = null;
  if (tryWatermarks) {
    const watermarkPages = plans.map((_, index) => index).filter(index => !footerPages.includes(index + 1));
    if (watermarkPages.length) {
      const { planPdfWatermarks } = await import("./pdf/watermark.js");
      plannedWatermarkLayout = await planPdfWatermarks(file, pageSealResults, watermarkPages);
      for (const index of watermarkPages) if (!plannedWatermarkLayout[index]) footerPages.push(index + 1);
    }
  }
  async function renderSealedPdf() {
    const pdf = await PDFDocument.load(await file.arrayBuffer());
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const pages = pdf.getPages();
    if (pages.length !== pageSealResults.length) throw new Error("PDF page count changed while sealing");

    const PANEL_MARGIN = 18;
    const PANEL_PADDING = 10;
    const watermarkLayout = plannedWatermarkLayout?.map((layout, index) => footerPages.includes(index + 1) ? null : layout) ?? null;
    if (watermarkLayout?.some(Boolean)) {
      const { stampWatermarks } = await import("./pdf/watermark.js");
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
      const { checkWatermarks } = await import("./pdf/watermark.js");
      failed = await checkWatermarks(sealedBytes, watermarkLayout, pageSealResults);
    }
    return { sealedBytes, watermarkLayout, failed };
  }
  let rendered;
  do {
    rendered = await renderSealedPdf();
    for (const index of rendered.failed) if (!footerPages.includes(index + 1)) footerPages.push(index + 1);
  } while (rendered.failed.length);
  const { sealedBytes, watermarkLayout } = rendered;
  footerPages.sort((a, b) => a - b);
  const pageSealStrings = pageSealResults.map((result) => result.seals);
  const firstResult = pageSealResults[0] ?? null;
  return {
    blob: new Blob([sealedBytes], { type: "application/pdf" }),
    sealResult: firstResult,
    stampedQrValues: firstResult?.seals ?? [],
    pageSealResults,
    pageSealStrings,
    flattenedFieldCount: prepared.flattenedFieldCount,
    watermarkLayout,
    footerPages,
  };
}
