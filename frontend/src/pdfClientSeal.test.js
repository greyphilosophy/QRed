import { Buffer } from "node:buffer";
import jsQR from "jsqr";
import { PDFDocument } from "pdf-lib";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { planQrStampLayout, qrPngBytes, sealPdfInBrowser } from "./pdfClientSeal.js";
import { qrScanAction } from "./QrScanner.jsx";
import { createQRedQrData, qredQrPngDataUrl, qredRasterPlan, qredVisibleBitsLength } from "./qredQr.js";
import { extractHiddenQRedPayload, verifyQRedSeals, VISIBLE_QR_TEXT } from "./qredVerifier.js";

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

async function makeTwoPagePdfFile() {
  const pdf = await PDFDocument.create();
  const firstPage = pdf.addPage([612, 792]);
  firstPage.drawText("Page one: this PDF should get its own seal set.", { x: 72, y: 720, size: 12 });
  const secondPage = pdf.addPage([612, 792]);
  secondPage.drawText("Page two: this PDF should not reuse page one seals.", { x: 72, y: 720, size: 12 });
  const bytes = await pdf.save();
  return new File([bytes], "two-pages.pdf", { type: "application/pdf" });
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
  return qr || null;
}

async function scanQRedPngDataUrl(dataUrl) {
  const png = PNG.sync.read(Buffer.from(dataUrl.split(",")[1], "base64"));
  const imageData = new Uint8ClampedArray(png.data);
  const code = jsQR(imageData, png.width, png.height);
  return qrScanAction(imageData, png.width, png.height, code);
}

function bitAt(bytes, index) {
  return (bytes[Math.floor(index / 8)] >>> (7 - (index % 8))) & 1;
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

  it("stamps each page with its own QR seal set instead of repeating the full document set", async () => {
    const file = await makeTwoPagePdfFile();

    const { pageSealResults, pageSealStrings, stampedQrValues } = await sealPdfInBrowser({
      file,
      issuer: "QRed Page Authority",
      privateKey,
      publicKey,
    });

    expect(pageSealResults).toHaveLength(2);
    expect(pageSealStrings).toHaveLength(2);
    expect(pageSealStrings[0]).not.toEqual(pageSealStrings[1]);
    expect(pageSealResults[0].document_id).not.toEqual(pageSealResults[1].document_id);
    expect(stampedQrValues).toEqual(pageSealStrings[0]);
  });

  it("expands letter pages to legal size when asked to create a footer for QR seals", async () => {
    const file = await makeLetterPdfFile();

    const { blob } = await sealPdfInBrowser({
      file,
      issuer: "QRed Letter Authority",
      privateKey,
      publicKey,
      pageScalingStrategy: "legal-footer",
    });

    const printedPdf = await PDFDocument.load(await blob.arrayBuffer());
    const [printedPage] = printedPdf.getPages();
    expect(Math.round(printedPage.getWidth())).toBe(612);
    expect(Math.round(printedPage.getHeight())).toBe(1008);
  });

  it("shrinks page content without changing the source page size when asked", async () => {
    const file = await makeLetterPdfFile();

    const { blob } = await sealPdfInBrowser({
      file,
      issuer: "QRed Letter Authority",
      privateKey,
      publicKey,
      pageScalingStrategy: "shrink-footer",
    });

    const printedPdf = await PDFDocument.load(await blob.arrayBuffer());
    const [printedPage] = printedPdf.getPages();
    expect(Math.round(printedPage.getWidth())).toBe(612);
    expect(Math.round(printedPage.getHeight())).toBe(792);
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
      content: expect.stringContaining("Dear verifier,"),
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
    expect(scannedQrValue).toMatchObject({ data: VISIBLE_QR_TEXT });
  });

  it("shows plaintext document text when a PDF is sealed with the plaintext recipe", async () => {
    const file = await makeLetterPdfFile();

    const { sealResult } = await sealPdfInBrowser({
      file,
      issuer: "QRed Plaintext Authority",
      privateKey,
      publicKey,
      encodingStrategy: "plaintext",
    });

    const firstSealScan = await scanQRedPngDataUrl(await qredQrPngDataUrl(sealResult.seals[0]));
    expect(firstSealScan).toMatchObject({
      status: "found",
      text: expect.stringContaining("Dear verifier,"),
    });
  });

  it("chooses error correction dynamically while allowing callers to pin a level", () => {
    const autoData = createQRedQrData("small payload");
    const pinnedData = createQRedQrData("small payload", { errorCorrectionLevel: "M" });

    expect(autoData.errorCorrectionLevel.bit).toBe(2);
    expect(pinnedData.errorCorrectionLevel.bit).toBe(0);
    expect(extractHiddenQRedPayload(autoData.bytes, autoData.version)).toBe("small payload");
    expect(extractHiddenQRedPayload(pinnedData.bytes, pinnedData.version)).toBe("small payload");
  });

  it("generates spec-compatible QRED.ORG alphanumeric QR codes with hidden payload padding that scanners can read", async () => {
    const file = await makeLetterPdfFile();
    const { stampedQrValues } = await sealPdfInBrowser({
      file,
      issuer: "QRed Spec Authority",
      privateKey,
      publicKey,
    });

    const scanResult = scanQrPng(await qrPngBytes(stampedQrValues[0]));
    expect(scanResult).toMatchObject({ data: VISIBLE_QR_TEXT });
    const qrData = createQRedQrData(stampedQrValues[0]);
    const visibleBits = qredVisibleBitsLength(qrData.version);
    expect(scanResult.version).toBe(qrData.version);
    expect(Array.from({ length: 4 }, (_, index) => bitAt(qrData.bytes, visibleBits + index))).toEqual([0, 0, 0, 0]);
    expect(extractHiddenQRedPayload(qrData.bytes, qrData.version)).toBe(stampedQrValues[0]);
    await expect(verifyQRedSeals([extractHiddenQRedPayload(qrData.bytes, qrData.version)], publicKey)).resolves.toMatchObject({
      status: "VALID",
      issuer: "QRed Spec Authority",
    });
  });

  it("renders dense QR symbols with integer modules large enough for real scanners", () => {
    expect(qredRasterPlan(177, { margin: 4, width: 360 })).toEqual({
      margin: 4,
      tile: 4,
      width: 740,
    });
    expect(qredRasterPlan(57, { margin: 4, width: 360 })).toEqual({
      margin: 4,
      tile: 5,
      width: 325,
    });
  });

  it("round-trips The Walrus and the Carpenter text through a generated QR and our scanner", async () => {
    const walrusText = [
      "The sun was shining on the sea,",
      "Shining with all his might:",
      "He did his very best to make",
      "The billows smooth and bright —",
      "And this was odd, because it was",
      "The middle of the night.",
    ].join("\n");

    await expect(scanQRedPngDataUrl(await qredQrPngDataUrl(walrusText))).resolves.toEqual({
      status: "found",
      text: walrusText,
    });
  });
});
