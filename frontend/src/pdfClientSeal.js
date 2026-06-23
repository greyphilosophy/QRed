import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import QRCode from "qrcode";
import { createQRedSeals, DEFAULT_BOOTSTRAP_URL } from "./qredSealer.js";

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

async function qrPngBytes(value) {
  const dataUrl = await QRCode.toDataURL(value, { errorCorrectionLevel: "M", margin: 1, width: 180 });
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function sealPdfInBrowser({
  file,
  issuer,
  privateKey,
  publicKey,
  bootstrapUrl = DEFAULT_BOOTSTRAP_URL,
}) {
  const digest = await fileDigestHex(file);
  const sealResult = await createQRedSeals({
    content: buildPdfManifest(file, digest),
    issuer,
    privateKey,
    publicKey,
    bootstrapUrl,
  });
  const pdf = await PDFDocument.load(await file.arrayBuffer());
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const qrValues = [bootstrapUrl, ...sealResult.seals];
  const qrImages = await Promise.all(qrValues.map(async (value) => pdf.embedPng(await qrPngBytes(value))));

  for (const page of pdf.getPages()) {
    const { width } = page.getSize();
    page.drawRectangle({ x: 18, y: 18, width: Math.min(width - 36, 470), height: 92, color: rgb(1, 1, 1), opacity: 0.92 });
    page.drawText("QRed sealed PDF manifest", { x: 28, y: 94, size: 9, font, color: rgb(0.05, 0.12, 0.22) });
    qrImages.forEach((image, index) => {
      page.drawImage(image, { x: 28 + (index * 72), y: 28, width: 58, height: 58 });
    });
  }

  const sealedBytes = await pdf.save();
  return {
    blob: new Blob([sealedBytes], { type: "application/pdf" }),
    sealResult,
  };
}
