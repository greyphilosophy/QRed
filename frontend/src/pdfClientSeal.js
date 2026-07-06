import { PDFDocument, rgb, StandardFonts, PDFName } from "pdf-lib";
import { createQRedSeals, DEFAULT_BOOTSTRAP_URL } from "./qredSealer.js";
import { qredQrPngDataUrl } from "./qredQr.js";

export const QR_SIZE = 177;
const QR_GAP = 10;
const PANEL_MARGIN = 18;
const PANEL_PADDING = 10;
const PANEL_LABEL_HEIGHT = 18;

async function fileDigestHex(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildPdfManifest(file, digest) {
  return [
    `PDF file: ${file.name}`,
    `Size: ${file.size} bytes`,
    `SHA-256: ${digest}`,
  ].join("\n");
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
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
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

  const bfrangePattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[(.*?)\]|<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/gs;
  for (const match of text.matchAll(bfrangePattern)) {
    if (match[1] && match[2] && match[3]) {
      const start = Number.parseInt(match[1], 16);
      const end = Number.parseInt(match[2], 16);
      const targets = [...match[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((m) => m[1]);
      for (let code = start, idx = 0; code <= end && idx < targets.length; code += 1, idx += 1) {
        const chars = [];
        const unicode = targets[idx];
        for (let i = 0; i < unicode.length; i += 4) {
          const cp = Number.parseInt(unicode.slice(i, i + 4), 16);
          if (!Number.isNaN(cp)) chars.push(String.fromCodePoint(cp));
        }
        map.set(code.toString(16).toUpperCase().padStart(match[1].length, "0"), chars.join(""));
      }
    } else if (match[4] && match[5] && match[6]) {
      const start = Number.parseInt(match[4], 16);
      const end = Number.parseInt(match[5], 16);
      const base = Number.parseInt(match[6], 16);
      for (let code = start; code <= end; code += 1) {
        map.set(code.toString(16).toUpperCase().padStart(match[4].length, "0"), String.fromCodePoint(base + (code - start)));
      }
    }
  }

  return map;
}

function decodeBytesWithMap(bytes, fontMap) {
  if (!fontMap || fontMap.size === 0) return bytesToLatin1(bytes);
  let out = "";
  for (const byte of bytes) {
    const key = byte.toString(16).toUpperCase().padStart(2, "0");
    out += fontMap.get(key) ?? String.fromCharCode(byte);
  }
  return out;
}

function extractTextFromContentString(content, fontMap) {
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

async function extractPdfText(file) {
  try {
    const pdf = await PDFDocument.load(await file.arrayBuffer());
    const pages = [];
    for (const page of pdf.getPages()) {
      const entries = page.node.normalizedEntries();
      const contents = entries.Contents;
      if (!contents) continue;

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
        if (typeof stream.getUnencodedContents === "function") bytes = stream.getUnencodedContents();
        else if (typeof stream.getContents === "function") bytes = await maybeInflate(stream.getContents());
        else if (typeof stream.asUint8Array === "function") bytes = await maybeInflate(stream.asUint8Array());
        if (!bytes || bytes.length === 0) continue;
        const content = bytesToLatin1(bytes);
        const extracted = extractTextFromContentString(content, fontMaps);
        if (extracted) pageTexts.push(extracted);
      }
      const joined = pageTexts.join(" ").trim();
      if (joined) pages.push(joined);
    }
    const extracted = pages.join("\n\n").trim();

    // Heuristic: if we ended up decoding mostly control characters, the PDF
    // likely lacks a usable ToUnicode map for its fonts. In that case, fall
    // back to pdf.js which handles more real-world PDFs.
    const controlChars = extracted
      .split("")
      .filter((ch) => {
        const code = ch.charCodeAt(0);
        // allow common whitespace; everything else under 0x20 is suspicious
        return code < 0x20 && ![0x09, 0x0a, 0x0d].includes(code);
      }).length;
    const controlRatio = extracted.length ? controlChars / extracted.length : 0;

    if (extracted && controlRatio >= 0.25) {
      const pdfjsFallback = await extractPdfTextWithPdfJs(file);
      if (pdfjsFallback) return pdfjsFallback;
    }

    return extracted;
  } catch {
    return "";
  }
}

async function extractPdfTextWithPdfJs(file) {
  try {
    // Dynamic import keeps pdf.js out of the hot path.
    const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
    const { GlobalWorkerOptions, getDocument } = pdfjs;

    // Use bundled worker (no CDN) so this works in Cloudflare/static contexts.
    GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();

    // Ensure extraction works even when Workers are blocked.
    GlobalWorkerOptions.workerPort = null;

    const arrayBuffer = await file.arrayBuffer();

    const loadingTask = getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;

    const pages = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const strings = (textContent.items || [])
        .map((item) => item && item.str)
        .filter((s) => typeof s === "string");
      const joined = strings.join(" ").replace(/\s+/g, " ").trim();
      if (joined) pages.push(joined);
    }

    return pages.join("\n\n").trim();
  } catch {
    return "";
  }
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

export async function sealPdfInBrowser({
  file,
  issuer,
  privateKey,
  publicKey,
  bootstrapUrl = DEFAULT_BOOTSTRAP_URL,
  encodingStrategy = "automatic",
}) {
  const digest = await fileDigestHex(file);
  const pdfText = await extractPdfText(file);
  const sealResult = await createQRedSeals({
    content: pdfText || buildPdfManifest(file, digest),
    issuer,
    privateKey,
    publicKey,
    bootstrapUrl,
    encodingStrategy,
  });
  const pdf = await PDFDocument.load(await file.arrayBuffer());
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const qrValues = sealResult.seals;
  const qrImages = await Promise.all(qrValues.map(async (value) => pdf.embedPng(await qrPngBytes(value))));

  for (const page of pdf.getPages()) {
    const { width } = page.getSize();
    const layout = planQrStampLayout(width, qrImages.length);
    page.drawRectangle({
      x: PANEL_MARGIN,
      y: PANEL_MARGIN,
      width: layout.panelWidth,
      height: layout.panelHeight,
      color: rgb(1, 1, 1),
      opacity: 0.94,
    });
    page.drawText("QRed sealed PDF manifest", {
      x: PANEL_MARGIN + PANEL_PADDING,
      y: PANEL_MARGIN + layout.panelHeight - PANEL_PADDING - 9,
      size: 9,
      font,
      color: rgb(0.05, 0.12, 0.22),
    });
    qrImages.forEach((image, index) => {
      const column = index % layout.columns;
      const row = Math.floor(index / layout.columns);
      const x = PANEL_MARGIN + PANEL_PADDING + (column * (layout.qrSize + layout.gap));
      const y = PANEL_MARGIN + PANEL_PADDING + ((layout.rows - row - 1) * (layout.qrSize + layout.gap));
      page.drawImage(image, { x, y, width: layout.qrSize, height: layout.qrSize });
    });
  }

  const sealedBytes = await pdf.save();
  return {
    blob: new Blob([sealedBytes], { type: "application/pdf" }),
    sealResult,
    stampedQrValues: qrValues,
  };
}
