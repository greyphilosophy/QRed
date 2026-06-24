import { Buffer } from "node:buffer";
import jsQR from "jsqr";
import { PDFDocument } from "pdf-lib";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { planQrStampLayout, qrPngBytes, sealPdfInBrowser } from "./pdfClientSeal.js";
import { verifyQRedSeals } from "./qredVerifier.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";

async function makePdfFile({ name = "static.pdf", size = [300, 300], text = "Static deployment PDF" } = {}) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage(size);
  page.drawText(text);
  const bytes = await pdf.save();
  return new File([bytes], name, { type: "application/pdf" });
}

async function makeLetterPdfFile() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  page.drawText("Dear verifier,", { x: 72, y: 720, size: 12 });
  page.drawText("This letter is sealed with all QRed payload QR codes needed for verification.", { x: 72, y: 696, size: 12 });
  page.drawText("Sincerely, QRed QA", { x: 72, y: 648, size: 12 });
  const bytes = await pdf.save();
  return new File([bytes], "letter.pdf", { type: "application/pdf" });
}

async function printBlobToPdf(blob) {
  const sourcePdf = await PDFDocument.load(await blob.arrayBuffer());
  const printedPdf = await PDFDocument.create();
  const copiedPages = await printedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
  copiedPages.forEach((page) => printedPdf.addPage(page));
  return printedPdf.save();
}

function scanQrPng(bytes) {
  const png = PNG.sync.read(Buffer.from(bytes));
  const qr = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return qr?.data || null;
}

describe("browser PDF sealing", () => {
  it("stamps a PDF and returns verifier-compatible manifest seals", async () => {
    const file = await makePdfFile();

    const { blob, sealResult } = await sealPdfInBrowser({
      file,
      issuer: "QRed Browser Demo",
      privateKey,
      publicKey,
    });

    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(file.size);
    expect(sealResult.seals.length).toBeGreaterThan(0);
    await expect(verifyQRedSeals(sealResult.seals, publicKey)).resolves.toMatchObject({
      status: "VALID",
      issuer: "QRed Browser Demo",
    });
  });

  it("generates QR seals for a PDF letter, stamps every verifier QR, and validates the stamped seals", async () => {
    const file = await makeLetterPdfFile();

    const { blob, sealResult, stampedQrValues } = await sealPdfInBrowser({
      file,
      issuer: "QRed Letter Authority",
      privateKey,
      publicKey,
    });

    expect(blob.type).toBe("application/pdf");
    expect(stampedQrValues).toEqual(sealResult.seals);
    expect(stampedQrValues[0]).toMatch(/^https:\/\/qred\.org\/#QRED1\?/);

    const layout = planQrStampLayout(612, stampedQrValues.length);
    expect(layout.qrSize).toBeGreaterThanOrEqual(177);
    expect(layout.columns * layout.rows).toBeGreaterThanOrEqual(stampedQrValues.length);
    expect(layout.panelWidth).toBeLessThanOrEqual(612 - 36);

    await expect(verifyQRedSeals(stampedQrValues, publicKey)).resolves.toMatchObject({
      status: "VALID",
      issuer: "QRed Letter Authority",
      content: expect.stringContaining("PDF file: letter.pdf"),
    });
  });

  it("keeps printed QR40-capacity stamps large enough to scan after print-to-PDF", async () => {
    const file = await makeLetterPdfFile();

    const { blob, stampedQrValues } = await sealPdfInBrowser({
      file,
      issuer: "QRed Print QA",
      privateKey,
      publicKey,
    });

    const printedBytes = await printBlobToPdf(blob);
    const printedPdf = await PDFDocument.load(printedBytes);
    const [printedPage] = printedPdf.getPages();
    const printedLayout = planQrStampLayout(printedPage.getWidth(), stampedQrValues.length);

    expect(printedLayout.qrSize).toBeGreaterThanOrEqual(177);
    expect(printedLayout.qrSize / 72).toBeGreaterThanOrEqual(177 / 72);

    const scannedQrValue = scanQrPng(await qrPngBytes(stampedQrValues[0]));
    expect(scannedQrValue).toBe(stampedQrValues[0]);
  });
});
