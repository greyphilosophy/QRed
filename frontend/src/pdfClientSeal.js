import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
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

function extractTextFromContentString(content) {
  const texts = [];

  const hexMatches = content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g);
  for (const match of hexMatches) {
    const hex = match[1];
    if (hex.length % 2 !== 0) continue;
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < hex.length; index += 2) {
      bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
    }
    texts.push(bytesToLatin1(bytes));
  }

  const literalMatches = content.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g);
  for (const match of literalMatches) texts.push(decodePdfLiteralString(match[1]));

  const arrayMatches = content.matchAll(/\[(.*?)\]\s*TJ/gs);
  for (const match of arrayMatches) {
    const chunk = match[1];
    const pieces = [
      ...chunk.matchAll(/<([0-9A-Fa-f]+)>|\(((?:\\.|[^\\)])*)\)/g),
    ];
    for (const piece of pieces) {
      if (piece[1]) {
        const hex = piece[1];
        if (hex.length % 2 !== 0) continue;
        const bytes = new Uint8Array(hex.length / 2);
        for (let index = 0; index < hex.length; index += 2) {
          bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
        }
        texts.push(bytesToLatin1(bytes));
      } else if (piece[2]) {
        texts.push(decodePdfLiteralString(piece[2]));
      }
    }
  }

  return texts.join(" ").replace(/\s+/g, " ").trim();
}

async function extractPdfText(file) {
  try {
    const pdf = await PDFDocument.load(await file.arrayBuffer());
    const pages = [];
    for (const page of pdf.getPages()) {
      const contents = page.node.normalizedEntries().Contents;
      if (!contents) continue;
      const pageTexts = [];
      for (let index = 0; index < contents.size(); index += 1) {
        const stream = contents.lookup(index);
        let bytes = null;
        if (typeof stream.getUnencodedContents === "function") bytes = stream.getUnencodedContents();
        else if (typeof stream.getContents === "function") bytes = await maybeInflate(stream.getContents());
        else if (typeof stream.asUint8Array === "function") bytes = await maybeInflate(stream.asUint8Array());
        if (!bytes || bytes.length === 0) continue;
        const content = bytesToLatin1(bytes);
        const extracted = extractTextFromContentString(content);
        if (extracted) pageTexts.push(extracted);
      }
      const joined = pageTexts.join(" ").trim();
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
