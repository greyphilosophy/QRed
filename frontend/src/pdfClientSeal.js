import { PDFDocument, rgb, StandardFonts, PDFName } from "pdf-lib";
import { createQRedSeals, DEFAULT_BOOTSTRAP_URL, canonicalizeText } from "./qredSealer.js";
import { qredQrPngDataUrl } from "./qredQr.js";

export const QR_SIZE = 177;
const QR_GAP = 10;
const PANEL_MARGIN = 18;
const PANEL_PADDING = 10;
const PANEL_LABEL_HEIGHT = 18;
const LETTER_PAGE_WIDTH = 612;
const LETTER_PAGE_HEIGHT = 792;
export const LEGAL_PAGE_HEIGHT = 1008;
export const LEGAL_FOOTER_HEIGHT = 216;

function isLetterSizedPage(width, height) {
  return Math.abs(width - LETTER_PAGE_WIDTH) <= 2 && Math.abs(height - LETTER_PAGE_HEIGHT) <= 2;
}

function resolvePageScalingStrategy(strategy, width, height) {
  if (strategy !== "automatic") return strategy;
  return isLetterSizedPage(width, height) ? "legal-footer" : "shrink-footer";
}

async function applyPageScaling(pdf, pageIndex, page, resolvedStrategy, footerHeight) {
  const { width, height } = page.getSize();

  if (resolvedStrategy === "legal-footer") {
    const embeddedPage = await pdf.embedPage(page);
    const replacementPage = pdf.insertPage(pageIndex + 1, [width, height + footerHeight]);
    replacementPage.drawPage(embeddedPage, {
      x: 0,
      y: footerHeight,
      width,
      height,
    });
    pdf.removePage(pageIndex);
    return replacementPage;
  }

  if (resolvedStrategy === "shrink-footer") {
    const availableContentHeight = height - footerHeight;
    if (availableContentHeight <= 0) {
      throw new Error("PDF page is too short to shrink for the selected seal footer");
    }

    const scale = availableContentHeight / height;
    const embeddedPage = await pdf.embedPage(page);
    const replacementPage = pdf.insertPage(pageIndex + 1, [width, height]);
    replacementPage.drawPage(embeddedPage, {
      x: 0,
      y: footerHeight,
      width: width * scale,
      height: height * scale,
    });
    pdf.removePage(pageIndex);
    return replacementPage;
  }

  return page;
}

function bytesToLatin1(bytes) {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

function decodePdfLiteralString(raw) {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    i += 1;
    const next = raw[i];
    if (next === undefined) break;
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "b") out += "\b";
    else if (next === "f") out += "\f";
    else if (next === "(" || next === ")" || next === "\\") out += next;
    else if (/[0-7]/.test(next)) {
      let oct = next;
      for (let j = 0; j < 2 && /[0-7]/.test(raw[i + 1]); j += 1) {
        i += 1;
        oct += raw[i];
      }
      out += String.fromCharCode(Number.parseInt(oct, 8));
    } else {
      out += next;
    }
  }
  return out;
}

async function maybeInflate(bytes) {
  try {
    // PDF "FlateDecode" payloads are usually zlib-wrapped (RFC1950), but
    // DecompressionStream('deflate') expects raw DEFLATE.
    //
    // Try raw first, then attempt zlib unwrap: 2-byte zlib header + raw deflate +
    // 4-byte Adler32 footer.
    const tryInflate = async (payload) => {
      const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream("deflate"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    };

    try {
      return await tryInflate(bytes);
    } catch {
      if (bytes && bytes.length > 6 && bytes[0] === 0x78) {
        const unwrapped = bytes.subarray(2, bytes.length - 4);
        return await tryInflate(unwrapped);
      }
      throw new Error("inflate failed");
    }
  } catch {
    return bytes;
  }
}

function parseCMap(text) {
  const map = new Map();
  const bfcharPattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
  for (const match of text.matchAll(bfcharPattern)) {
    const code = match[1].toUpperCase();
    const unicode = match[2];
    const chars = [];
    for (let i = 0; i < unicode.length; i += 4) {
      const cp = Number.parseInt(unicode.slice(i, i + 4), 16);
      if (!Number.isNaN(cp)) chars.push(String.fromCodePoint(cp));
    }
    map.set(code, chars.join(""));
  }

  return map;
}

function decodeBytesWithMap(bytes, fontMap) {
  if (!fontMap || fontMap.size === 0) return bytesToLatin1(bytes);
  const firstKey = fontMap.keys().next().value;
  // ToUnicode maps may use 1-byte codes (e.g. "41") or 2-byte codes (e.g. "0002").
  // Decode in the same granularity.
  const keyLen = typeof firstKey === "string" ? firstKey.length : 0;
  const bytesPerChar = keyLen % 2 === 0 && keyLen > 0 ? keyLen / 2 : 1;

  let out = "";
  for (let i = 0; i < bytes.length; i += bytesPerChar) {
    const slice = bytes.slice(i, i + bytesPerChar);
    if (slice.length === bytesPerChar) {
      const key = Array.from(slice, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join("");
      out += fontMap.get(key) ?? String.fromCharCode(slice[slice.length - 1]);
    } else {
      // trailing partial; fall back to per-byte decode
      for (const byte of slice) {
        const key = byte.toString(16).toUpperCase().padStart(2, "0");
        out += fontMap.get(key) ?? String.fromCharCode(byte);
      }
    }
  }
  return out;
}

export function extractTextFromContentString(content, fontMap) {
  const texts = [];
  const scanner = /\/([!#-~]+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj|\[(.*?)\]\s*TJ/gs;
  let currentFont = fontMap;
  for (const match of content.matchAll(scanner)) {
    if (match[1]) {
      currentFont = fontMap?.[match[1]] || fontMap?.get?.(match[1]) || null;
      continue;
    }
    if (match[2]) {
      const hex = match[2];
      if (hex.length % 2 !== 0) continue;
      const bytes = new Uint8Array(hex.length / 2);
      for (let index = 0; index < hex.length; index += 2) {
        bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
      }
      texts.push(decodeBytesWithMap(bytes, currentFont));
      continue;
    }
    if (match[3]) {
      texts.push(decodeBytesWithMap(Uint8Array.from(match[3], (ch) => ch.charCodeAt(0)), currentFont));
      continue;
    }
    if (match[4]) {
      const chunk = match[4];
      const pieces = [...chunk.matchAll(/<([0-9A-Fa-f]+)>|\(((?:\\.|[^\\)])*)\)/g)];
      for (const piece of pieces) {
        if (piece[1]) {
          const hex = piece[1];
          if (hex.length % 2 !== 0) continue;
          const bytes = new Uint8Array(hex.length / 2);
          for (let index = 0; index < hex.length; index += 2) {
            bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
          }
          texts.push(decodeBytesWithMap(bytes, currentFont));
        } else if (piece[2]) {
          texts.push(decodeBytesWithMap(Uint8Array.from(decodePdfLiteralString(piece[2]), (ch) => ch.charCodeAt(0)), currentFont));
        }
      }
    }
  }

  return texts.join("").replace(/\s+/g, " ").trim();
}

async function extractPdfPageTexts(file) {
  try {
    const pdf = await PDFDocument.load(await file.arrayBuffer());
    const pages = [];
    for (const page of pdf.getPages()) {
      const entries = page.node.normalizedEntries();
      const contents = entries.Contents;
      if (!contents) {
        pages.push("");
        continue;
      }

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
  } catch {
    return [];
  }
}

export async function extractPdfText(file) {
  return extractPdfPageTexts(file).then((pages) => pages.join("\n\n").trim());
}

async function sha256Hex(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function pageContentHash(pageText) {
  return sha256Hex(canonicalizeText(pageText));
}

async function documentMerkleRoot(pageTexts) {
  const leaves = await Promise.all(pageTexts.map((pageText) => pageContentHash(pageText)));
  if (leaves.length === 0) {
    return sha256Hex(new Uint8Array());
  }

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
  return [
    "QRed PDF page integrity",
    `Page SHA256: ${pageHash}`,
    `Document Merkle Root: ${merkleRoot}`,
    "",
    canonicalPageText,
  ].join("\n");
}

async function pageSealDocumentId(merkleRoot, pageText, sealOccurrenceNumber) {
  return sha256Hex(`${merkleRoot}${await pageContentHash(pageText)}${sealOccurrenceNumber}`);
}

async function createPageSealResults({
  file,
  issuer,
  privateKey,
  publicKey,
  bootstrapUrl,
  encodingStrategy,
}) {
  const pageTexts = await extractPdfPageTexts(file);
  const merkleRoot = await documentMerkleRoot(pageTexts);
  return Promise.all(pageTexts.map(async (pageText, pageIndex) => {
    const documentId = await pageSealDocumentId(merkleRoot, pageText, pageIndex);
    return createQRedSeals({
      content: await pageIntegrityText(pageText, merkleRoot),
      issuer,
      privateKey,
      publicKey,
      documentId,
      bootstrapUrl,
      encodingStrategy,
    });
  }));
}

export async function qrPngBytes(value) {
  const dataUrl = await qredQrPngDataUrl(value, { margin: 4, width: 360 });
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function planQrStampLayout(pageWidth, qrCount) {
  const usableWidth = Math.max(QR_SIZE, pageWidth - (PANEL_MARGIN * 2) - (PANEL_PADDING * 2));
  const columns = Math.max(1, Math.floor((usableWidth + QR_GAP) / (QR_SIZE + QR_GAP)));
  const rows = Math.max(1, Math.ceil(qrCount / columns));
  const panelWidth = Math.min(
    pageWidth - (PANEL_MARGIN * 2),
    (PANEL_PADDING * 2) + (columns * QR_SIZE) + ((columns - 1) * QR_GAP),
  );
  const panelHeight = (PANEL_PADDING * 2) + PANEL_LABEL_HEIGHT + (rows * QR_SIZE) + ((rows - 1) * QR_GAP);
  return { columns, rows, panelWidth, panelHeight, qrSize: QR_SIZE, gap: QR_GAP };
}

function makeLayout(columns, rows, qrSize) {
  return {
    columns,
    rows,
    panelWidth: (PANEL_PADDING * 2) + (columns * qrSize) + ((columns - 1) * QR_GAP),
    panelHeight: (PANEL_PADDING * 2) + PANEL_LABEL_HEIGHT + (rows * qrSize) + ((rows - 1) * QR_GAP),
    qrSize,
    gap: QR_GAP,
  };
}

function layoutFitsFooterBand(pageWidth, footerBandHeight, footerMargin, layout) {
  return layout.panelWidth <= pageWidth - (PANEL_MARGIN * 2) && layout.panelHeight <= footerBandHeight - footerMargin;
}

function planQrStampLayoutForSize(pageWidth, qrCount, qrSize, { footerBandHeight = null, footerMargin = PANEL_MARGIN } = {}) {
  const usableWidth = Math.max(qrSize, pageWidth - (PANEL_MARGIN * 2) - (PANEL_PADDING * 2));
  const maxColumns = Math.max(1, qrCount);
  let bestLayout = null;

  for (let columns = 1; columns <= maxColumns; columns += 1) {
    const rows = Math.max(1, Math.ceil(qrCount / columns));
    const layout = makeLayout(columns, rows, qrSize);
    const widthFits = layout.panelWidth <= pageWidth - (PANEL_MARGIN * 2) && layout.panelWidth <= usableWidth + (PANEL_PADDING * 2);
    const heightFits = footerBandHeight == null || layout.panelHeight <= footerBandHeight - footerMargin;
    if (!widthFits || !heightFits) continue;
    if (!bestLayout || layout.qrSize > bestLayout.qrSize || (layout.qrSize === bestLayout.qrSize && layout.columns > bestLayout.columns)) {
      bestLayout = layout;
    }
  }

  return bestLayout;
}

export function planQrStampLayoutForFooterBand(pageWidth, qrCount, { footerBandHeight = LEGAL_FOOTER_HEIGHT, footerMargin = 1, minQrSize = 32 } = {}) {
  const maxAvailableHeight = footerBandHeight - footerMargin - (PANEL_PADDING * 2) - PANEL_LABEL_HEIGHT;
  if (maxAvailableHeight <= 0) {
    throw new Error("Selected QR seals do not fit within the bottom 3 inches of a legal-sized page");
  }

  const oneRowWidthLimit = Math.floor((pageWidth - (PANEL_MARGIN * 2) - (PANEL_PADDING * 2) - ((qrCount - 1) * QR_GAP)) / qrCount);
  const oneRowHeightLimit = Math.floor(maxAvailableHeight);
  const oneRowQrSize = Math.min(oneRowWidthLimit, oneRowHeightLimit);
  if (oneRowQrSize >= minQrSize) {
    const oneRowLayout = makeLayout(qrCount, 1, oneRowQrSize);
    if (layoutFitsFooterBand(pageWidth, footerBandHeight, footerMargin, oneRowLayout)) return oneRowLayout;
  }

  const maxColumns = Math.max(1, qrCount);
  let bestLayout = null;

  for (let columns = 2; columns <= maxColumns; columns += 1) {
    const rows = Math.max(1, Math.ceil(qrCount / columns));
    const widthLimit = Math.floor((pageWidth - (PANEL_MARGIN * 2) - (PANEL_PADDING * 2) - ((columns - 1) * QR_GAP)) / columns);
    const heightLimit = Math.floor((maxAvailableHeight - ((rows - 1) * QR_GAP)) / rows);
    const qrSize = Math.min(widthLimit, heightLimit);
    if (qrSize < minQrSize) continue;
    const layout = planQrStampLayoutForSize(pageWidth, qrCount, qrSize, { footerBandHeight, footerMargin });
    if (!layout) continue;
    if (!bestLayout || layout.qrSize > bestLayout.qrSize || (layout.qrSize === bestLayout.qrSize && layout.columns > bestLayout.columns)) {
      bestLayout = layout;
    }
  }

  if (!bestLayout) {
    throw new Error("Selected QR seals do not fit within the bottom 3 inches of a legal-sized page");
  }

  return bestLayout;
}

export async function sealPdfInBrowser({
  file,
  issuer,
  privateKey,
  publicKey,
  bootstrapUrl = DEFAULT_BOOTSTRAP_URL,
  encodingStrategy = "automatic",
  pageScalingStrategy = "automatic",
}) {
  const pageSealResults = await createPageSealResults({
    file,
    issuer,
    privateKey,
    publicKey,
    bootstrapUrl,
    encodingStrategy,
  });
  const pdf = await PDFDocument.load(await file.arrayBuffer());
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  if (pages.length !== pageSealResults.length) {
    throw new Error("PDF page count changed while sealing");
  }

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
    page.drawRectangle({
      x: footerMargin,
      y: footerMargin,
      width: layout.panelWidth,
      height: layout.panelHeight,
      color: rgb(1, 1, 1),
      opacity: 0.94,
    });
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
