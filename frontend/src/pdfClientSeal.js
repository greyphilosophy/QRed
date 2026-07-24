import { PDFDocument, rgb, StandardFonts, PDFName } from "pdf-lib";
import { createQRedSeals, DEFAULT_BOOTSTRAP_URL, canonicalizeText } from "./qredSealer.js";
import { qredQrPngDataUrl } from "./qredQr.js";
import { bytesToLatin1, maybeInflate, parseCMap, extractTextFromContentString } from "./pdf/pdfTextExtraction.js";
import { LEGAL_FOOTER_HEIGHT, LEGAL_PAGE_HEIGHT, resolvePageScalingStrategy, applyPageScaling } from "./pdf/pageScaling.js";
import { QR_SIZE, planQrStampLayout, planQrStampLayoutForFooterBand } from "./pdf/qrLayout.js";

export { QR_SIZE, LEGAL_PAGE_HEIGHT, LEGAL_FOOTER_HEIGHT };
export { planQrStampLayout, planQrStampLayoutForFooterBand };

async function extractPdfPageTexts(file) {
  try {
    const pdf = await PDFDocument.load(await file.arrayBuffer());
    const pages = [];
    for (const page of pdf.getPages()) {
      const entries = page.node.normalizedEntries();
      const contents = entries.Contents;
      if (!contents) { pages.push(""); continue; }

      const fontMaps = new Map();
      const fontDict = entries.Resources?.lookup?.(PDFName.of("Font"));
      if (fontDict) {
        for (const [fontName] of fontDict.entries()) {
          const fontObj = fontDict.lookup(fontName);
          const toUnicodeRef = fontObj.get(PDFName.of("ToUnicode"));
          if (!toUnicodeRef) continue;
          const cmapStream = pdf.context.lookup(toUnicodeRef);
          const cmapBytes = cmapStream && typeof cmapStream.getContents === "function" ? cmapStream.getContents() : null;
          if (!cmapBytes) continue;
          const cmapText = new TextDecoder("latin1").decode(await maybeInflate(cmapBytes));
          fontMaps.set(fontName.decodeText ? fontName.decodeText() : fontName.toString().replace(/^\//, ""), parseCMap(cmapText));
        }
      }

      const pageTexts = [];
      for (let index = 0; index < contents.size(); index += 1) {
        const stream = contents.lookup(index);
        let bytes = null;
        if (typeof stream.getUnencodedContents === "function") bytes = await maybeInflate(stream.getUnencodedContents());
        else if (typeof stream.getContents === "function") bytes = await maybeInflate(stream.getContents());
        else if (typeof stream.asUint8Array === "function") bytes = await maybeInflate(stream.asUint8Array());
        if (!bytes || bytes.length === 0) continue;
        const content = bytesToLatin1(bytes);
        const extracted = extractTextFromContentString(content, fontMaps);
        if (extracted) pageTexts.push(extracted);
      }
      pages.push(pageTexts.join(" ").trim());
    }
    return pages;
  } catch { return []; }
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

async function pageIntegrityText(pageText, merkleRoot) {
  const canonicalPageText = canonicalizeText(pageText);
  const pageHash = await pageContentHash(pageText);
  return ["QRed PDF page integrity", `Page SHA256: ${pageHash}`, `Document Merkle Root: ${merkleRoot}`, "", canonicalPageText].join("\n");
}

async function pageSealDocumentId(merkleRoot, pageText, sealOccurrenceNumber) {
  return sha256Hex(`${merkleRoot}${await pageContentHash(pageText)}${sealOccurrenceNumber}`);
}

async function createPageSealResults({ file, issuer, privateKey, publicKey, bootstrapUrl, encodingStrategy }) {
  const pageTexts = await extractPdfPageTexts(file);
  const merkleRoot = await documentMerkleRoot(pageTexts);
  return Promise.all(pageTexts.map(async (pageText, pageIndex) => {
    const documentId = await pageSealDocumentId(merkleRoot, pageText, pageIndex);
    return createQRedSeals({ content: await pageIntegrityText(pageText, merkleRoot), issuer, privateKey, publicKey, documentId, bootstrapUrl, encodingStrategy });
  }));
}

export async function qrPngBytes(value) {
  const dataUrl = await qredQrPngDataUrl(value, { margin: 4, width: 360 });
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function sealPdfInBrowser({ file, issuer, privateKey, publicKey, bootstrapUrl = DEFAULT_BOOTSTRAP_URL, encodingStrategy = "automatic", pageScalingStrategy = "automatic" }) {
  const pageSealResults = await createPageSealResults({ file, issuer, privateKey, publicKey, bootstrapUrl, encodingStrategy });
  const pdf = await PDFDocument.load(await file.arrayBuffer());
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  if (pages.length !== pageSealResults.length) throw new Error("PDF page count changed while sealing");

  const PANEL_MARGIN = 18;
  const PANEL_PADDING = 10;

  for (let pageIndex = pageSealResults.length - 1; pageIndex >= 0; pageIndex -= 1) {
    let page = pdf.getPage(pageIndex);
    const qrValues = pageSealResults[pageIndex].seals;
    const qrImages = await Promise.all(qrValues.map(async (value) => pdf.embedPng(await qrPngBytes(value))));
    const { width, height } = page.getSize();
    const resolvedPageScalingStrategy = resolvePageScalingStrategy(pageScalingStrategy, width, height);
    const layout = resolvedPageScalingStrategy === "legal-footer"
      ? planQrStampLayoutForFooterBand(width, qrImages.length, { footerBandHeight: LEGAL_FOOTER_HEIGHT, footerMargin: 1 })
      : planQrStampLayout(width, qrImages.length);
    const footerMargin = resolvedPageScalingStrategy === "legal-footer" ? 1 : PANEL_MARGIN;
    const footerHeight = resolvedPageScalingStrategy === "legal-footer" ? LEGAL_FOOTER_HEIGHT : footerMargin + layout.panelHeight;
    page = await applyPageScaling(pdf, pageIndex, page, resolvedPageScalingStrategy, footerHeight);
    page.drawRectangle({ x: footerMargin, y: footerMargin, width: layout.panelWidth, height: layout.panelHeight, color: rgb(1, 1, 1), opacity: 0.94 });
    page.drawText("QRed sealed PDF page", {
      x: footerMargin + PANEL_PADDING,
      y: footerMargin + layout.panelHeight - PANEL_PADDING - 9,
      size: 9,
      font,
      color: rgb(0.05, 0.12, 0.22),
    });
    qrImages.forEach((image, index) => {
      const column = index % layout.columns;
      const row = Math.floor(index / layout.columns);
      const x = footerMargin + PANEL_PADDING + (column * (layout.qrSize + layout.gap));
      const y = footerMargin + PANEL_PADDING + ((layout.rows - row - 1) * (layout.qrSize + layout.gap));
      page.drawImage(image, { x, y, width: layout.qrSize, height: layout.qrSize });
    });
  }

  const sealedBytes = await pdf.save();
  const pageSealStrings = pageSealResults.map((result) => result.seals);
  const firstResult = pageSealResults[0] ?? null;
  return {
    blob: new Blob([sealedBytes], { type: "application/pdf" }),
    sealResult: firstResult,
    stampedQrValues: firstResult?.seals ?? [],
    pageSealResults,
    pageSealStrings,
  };
}
