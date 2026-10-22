import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { createQRedSeals, DEFAULT_BOOTSTRAP_URL, canonicalizeText } from "./qredSealer.js";
import { qredQrPngDataUrl } from "./qredQr.js";
import { LEGAL_FOOTER_HEIGHT, LEGAL_PAGE_HEIGHT, resolvePageScalingStrategy, applyPageScaling } from "./pdf/pageScaling.js";
import { QR_SIZE, planQrStampLayout, planQrStampLayoutForFooterBand } from "./pdf/qrLayout.js";
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

async function pageContentHash(pageText) { return sha256Hex(canonicalizeText(pageText)); }

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
  const pageTexts = await extractPdfPageTexts(file);
  const unreadablePages = pageTexts.flatMap((text, index) => text.trim() ? [] : [index + 1]);
  if (unreadablePages.length) {
    throw new Error(`No readable text on PDF page(s) ${unreadablePages.join(", ")}. Scanned, image-only, and blank pages cannot be sealed. Add a checked OCR text layer or use a text PDF.`);
  }
  const merkleRoot = await documentMerkleRoot(pageTexts);
  const timestamp = new Date().toISOString();
  const contexts = pageTexts.map((_, index) => ({ pageNumber: index + 1, pageCount: pageTexts.length, documentRoot: merkleRoot }));
  const attestations = attestPages ? await attestPages(pageTexts.map((text, index) => ({
    content: canonicalizeText(text), metadata: { pdf: true, page_number: index + 1,
      page_count: pageTexts.length, document_root: pageTexts.length > 1 ? merkleRoot : null },
  }))) : null;
  if (attestations && attestations.length !== pageTexts.length) throw new Error("Missing page attestations");
  return Promise.all(pageTexts.map(async (pageText, pageIndex) => {
    return createQRedSeals({ content: pageText, privateKey, publicKey, bootstrapUrl, encodingStrategy, timestamp,
      pageContext: contexts[pageIndex], attestation: attestations?.[pageIndex] });
  }));
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
  const pageSealResults = await createPageSealResults({ file, privateKey, publicKey, bootstrapUrl, encodingStrategy, attestPages });
  const pdf = await PDFDocument.load(await file.arrayBuffer());
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  if (pages.length !== pageSealResults.length) throw new Error("PDF page count changed while sealing");

  const PANEL_MARGIN = 18;
  const PANEL_PADDING = 10;
  let watermarkLayout = null;

  if (pageScalingStrategy === "watermark") {
    const { stampWatermarks } = await import("./pdf/watermark.js");
    watermarkLayout = await stampWatermarks(pdf, file, pageSealResults);
  } else for (let pageIndex = pageSealResults.length - 1; pageIndex >= 0; pageIndex -= 1) {
    let page = pdf.getPage(pageIndex);
    const qrValues = pageSealResults[pageIndex].seals;
    const qrImages = await Promise.all(qrValues.map(async (value) => pdf.embedPng(await qrPngBytes(value))));
    const { width, height } = page.getSize();
    const resolvedPageScalingStrategy = resolvePageScalingStrategy(pageScalingStrategy, width, height);
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
  if (watermarkLayout) {
    const { checkWatermarks } = await import("./pdf/watermark.js");
    await checkWatermarks(sealedBytes, watermarkLayout, pageSealResults);
  }
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
  };
}
