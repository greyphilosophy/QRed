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

export async function qrPngBytes(value) {
  const dataUrl = await qredQrPngDataUrl(value, { errorCorrectionLevel: "M", margin: 2, width: 360 });
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
  const sealResult = await createQRedSeals({
    content: buildPdfManifest(file, digest),
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
