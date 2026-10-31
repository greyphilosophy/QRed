import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jsQR from "jsqr";
import { PDFDocument } from "pdf-lib";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { extractPdfText, LEGAL_FOOTER_HEIGHT, planQrStampLayout, planQrStampLayoutForFooterBand, qrPngBytes, sealPdfInBrowser } from "./pdfClientSeal.js";
import { qrScanAction } from "./QrScanner.jsx";
import { scanQrImage } from "./qr/scanQrImage.js";
import { createQRedQrData, qredQrPngDataUrl, qredRasterPlan, qredVisibleBitsLength } from "./qredQr.js";
import { extractHiddenQRedPayload, qredPayloadFromPhotoScanResult, verifyQRedSeals, VISIBLE_QR_TEXT } from "./qredVerifier.js";

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

async function makeHugeLetterPdfFile() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const hugeText = "QRed sealing content needs more than one footer row. ".repeat(600);
  page.drawText(hugeText, { x: 36, y: 744, size: 10, lineHeight: 12, maxWidth: 540 });
  const bytes = await pdf.save();
  return new File([bytes], "huge-letter.pdf", { type: "application/pdf" });
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

function renderPdfFirstPageToPng(pdfBytes, dpi = 144) {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const pdfPath = join(tmpdir(), `qred-seal-${stamp}.pdf`);
  const pngBase = join(tmpdir(), `qred-seal-${stamp}`);
  writeFileSync(pdfPath, Buffer.from(pdfBytes));
  execFileSync("pdftoppm", ["-png", "-r", String(dpi), "-singlefile", pdfPath, pngBase]);
  return PNG.sync.read(readFileSync(`${pngBase}.png`));
}

describe("browser PDF sealing", () => {
  it("recovers the actual text from an ASCII85/Flate PDF's rendered stamped QR", async () => {
    const file = new File([readFileSync("../tests/fixtures/ascii85-text.pdf")], "ascii85.pdf", { type: "application/pdf" });
    expect(await extractPdfText(file)).toContain("The approved total is 123.45 dollars.");
    const { blob } = await sealPdfInBrowser({ file, privateKey, publicKey, pageScalingStrategy: "legal-footer" });
    // Read the actual printed footer at normal print resolution, not the seal
    // string held in memory by the stamper (which missed the original bug).
    const page = renderPdfFirstPageToPng(await blob.arrayBuffer(), 300);
    const footerHeight = Math.round(LEGAL_FOOTER_HEIGHT * 300 / 72);
    const png = new PNG({ width: page.width, height: footerHeight });
    PNG.bitblt(page, png, 0, page.height - footerHeight, page.width, footerHeight, 0, 0);
    const pixels = new Uint8ClampedArray(png.data);
    const qr = jsQR(pixels, png.width, png.height);
    expect(qr?.data).toBe(VISIBLE_QR_TEXT);
    const payload = qredPayloadFromPhotoScanResult(pixels, png.width, png.height, qr);
    const result = await verifyQRedSeals([payload], publicKey);
    expect(result).toMatchObject({ status: "VALID", metadata_authenticated: true });
    for (const line of ["QRed audit sample", "The approved total is 123.45 dollars.", "This is a synthetic test document with no private information."]) {
      expect(result.content).toContain(line);
    }
    expect(result.content).not.toContain("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("extracts text inside embedded form objects", async () => {
    const source = await makeLetterPdfFile();
    const pdf = await PDFDocument.create();
    const [embedded] = await pdf.embedPdf(await source.arrayBuffer());
    pdf.addPage([612, 792]).drawPage(embedded);
    const file = new File([await pdf.save()], "form.pdf", { type: "application/pdf" });
    expect(await extractPdfText(file)).toContain("Dear verifier,");
  });

  it.each(["blank", "image-only", "mixed"])("seals %s pages with signed visual evidence or a blank marker", async (kind) => {
    const pdf = await PDFDocument.create();
    if (kind === "mixed") pdf.addPage([612, 792]).drawText("Readable first page");
    const page = pdf.addPage([612, 792]);
    if (kind !== "blank") {
      const image = await pdf.embedPng(readFileSync("../tests/qr_test_plain.png"));
      page.drawImage(image, { x: 72, y: 400, width: 200, height: 200 });
    }
    const file = new File([await pdf.save()], "unreadable.pdf", { type: "application/pdf" });
    const { pageSealStrings, footerPages, blob } = await sealPdfInBrowser({ file, privateKey, publicKey, pageScalingStrategy: "watermark" });
    expect(footerPages).toContain(kind === "mixed" ? 2 : 1);
    expect((await PDFDocument.load(await blob.arrayBuffer())).getPage(kind === "mixed" ? 1 : 0).getHeight()).toBe(1008);
    for (const seals of pageSealStrings) {
      expect(seals.length).toBeLessThanOrEqual(2);
      const result = await verifyQRedSeals(seals, publicKey);
      expect(result.status).toBe("VALID");
      if (!result.content) {
        expect(result.evidence.blank).toBe(kind === "blank");
        if (kind !== "blank") expect(result.evidence.visual.indices.length).toBeGreaterThan(0);
      }
    }
  });

  it("propagates invalid PDF errors instead of returning an empty extraction", async () => {
    await expect(extractPdfText(new File(["not a PDF"], "bad.pdf"))).rejects.toThrow();
  });

  it("stamps a PDF and returns verifier-compatible manifest seals", async () => {
    const file = await makePdfFile();

    const { blob, sealResult } = await sealPdfInBrowser({
      file,
      privateKey,
      publicKey,
    });

    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(file.size);
    expect(sealResult.seals.length).toBeGreaterThan(0);
    await expect(verifyQRedSeals(sealResult.seals, publicKey)).resolves.toMatchObject({
      status: "VALID",
    });
  });

  it("stamps each page with its own QR seal set instead of repeating the full document set", async () => {
    const file = await makeTwoPagePdfFile();

    const { pageSealResults, pageSealStrings, stampedQrValues } = await sealPdfInBrowser({
      file,
      privateKey,
      publicKey,
    });

    expect(pageSealResults).toHaveLength(2);
    expect(pageSealStrings).toHaveLength(2);
    expect(pageSealStrings[0]).not.toEqual(pageSealStrings[1]);
    expect(pageSealResults[0].document_id).not.toEqual(pageSealResults[1].document_id);
    expect(stampedQrValues).toEqual(pageSealStrings[0]);
    const results = await Promise.all(pageSealStrings.map(seals => verifyQRedSeals(seals, publicKey)));
    expect(results.map(result => result.status)).toEqual(["VALID", "VALID"]);
    expect(results.map(result => result.page_number)).toEqual([1, 2]);
    expect(results.every(result => result.page_count === 2)).toBe(true);
    expect(results[0].timestamp).toBe(results[1].timestamp);
    expect(results[0].document_root).toBe(results[1].document_root);
    expect(results[0].page_hash).not.toBe(results[1].page_hash);
    expect(results[0].content).not.toContain("QRed PDF page integrity");
  }, 30000);

  it("uses 2.75-inch QR seals for one or two seals in the legal footer", () => {
    for (const count of [1, 2]) {
      const layout = planQrStampLayoutForFooterBand(612, count);
      expect(layout.qrSize / 72).toBe(2.75);
      expect(layout.qrOffsetY).toBeGreaterThanOrEqual(18);
      expect(layout.qrOffsetY + layout.gridHeight).toBeLessThanOrEqual(LEGAL_FOOTER_HEIGHT);
      expect(layout.qrOffsetX + layout.gridWidth).toBeLessThanOrEqual(612 - 18);
    }
  });

  it("uses a larger multi-row grid when six seals must fit the legal footer", () => {
    const layout = planQrStampLayoutForFooterBand(612, 6, {
      footerBandHeight: LEGAL_FOOTER_HEIGHT,
    });

    expect(layout.rows).toBe(2);
    expect(layout.qrSize).toBeGreaterThan(84);
    expect(layout.qrOffsetY + layout.gridHeight).toBeLessThanOrEqual(LEGAL_FOOTER_HEIGHT);
    expect(layout.qrOffsetX + layout.gridWidth).toBeLessThanOrEqual(612 - 18);
  });

  it("preserves the original letter pixels and verifies its larger footer at 300 dpi", async () => {
    const source = readFileSync("../tests/fixtures/live-qa-invoice.pdf");
    const { blob, stampedQrValues } = await sealPdfInBrowser({
      file: new File([source], "invoice.pdf", { type: "application/pdf" }), privateKey, publicKey, pageScalingStrategy: "legal-footer",
    });
    const original = renderPdfFirstPageToPng(source, 300);
    const stamped = renderPdfFirstPageToPng(await blob.arrayBuffer(), 300);
    expect(stamped.width).toBe(original.width);
    expect(stamped.height - original.height).toBe(900);
    expect(stamped.data.subarray(0, original.data.length).equals(original.data)).toBe(true);
    const footer = new PNG({ width: stamped.width, height: 900 });
    PNG.bitblt(stamped, footer, 0, original.height, stamped.width, 900, 0, 0);
    const pixels = new Uint8ClampedArray(footer.data);
    const code = scanQrImage(pixels, footer.width, footer.height);
    expect(code?.data).toBe(VISIBLE_QR_TEXT);
    expect(code.version).toBe(createQRedQrData(stampedQrValues[0]).version);
    expect(code.version).toBeLessThan(createQRedQrData(stampedQrValues[0], { errorCorrectionLevel: "H" }).version);
    // Measure the saved PDF's QR footprint, including its four-module quiet
    // zone, from the detected corners. A smaller grid must still print 2.75".
    const modules = 17 + 4 * code.version;
    const { topLeftCorner, topRightCorner, bottomLeftCorner } = code.location;
    for (const corner of [topRightCorner, bottomLeftCorner]) {
      const side = Math.hypot(corner.x - topLeftCorner.x, corner.y - topLeftCorner.y);
      expect(side * (modules + 8) / modules / 300).toBeCloseTo(2.75, 1);
    }
    const seal = qredPayloadFromPhotoScanResult(pixels, footer.width, footer.height, code);
    await expect(verifyQRedSeals([seal], publicKey)).resolves.toMatchObject({
      status: "VALID", content: expect.stringContaining("Approved total: $123.45"),
    });
  });

  it("expands letter pages to legal size when asked to create a footer for QR seals", async () => {
    const file = await makeLetterPdfFile();

    const { blob } = await sealPdfInBrowser({
      file,
      privateKey,
      publicKey,
      pageScalingStrategy: "legal-footer",
    });

    const printedPdf = await PDFDocument.load(await blob.arrayBuffer());
    const [printedPage] = printedPdf.getPages();
    expect(Math.round(printedPage.getWidth())).toBe(612);
    expect(Math.round(printedPage.getHeight())).toBe(1008);
  });

  it("prints two balanced smaller grids at 2.75 inches and verifies their scanned contents", async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([612, 792]);
    for (let i = 0; i < 45; i += 1) {
      page.drawText(`Item ${i + 1}: Received and inspected; quantity ${i * 7 + 3}; approved for delivery.`,
        { x: 40, y: 740 - i * 14, size: 9 });
    }
    const { blob, stampedQrValues } = await sealPdfInBrowser({
      file: new File([await source.save()], "delivery-records.pdf", { type: "application/pdf" }), privateKey, publicKey, encodingStrategy: "plaintext", pageScalingStrategy: "legal-footer",
    });
    expect(stampedQrValues).toHaveLength(2);
    const printed = renderPdfFirstPageToPng(await blob.arrayBuffer(), 200);
    const scanned = [];
    for (let index = 0; index < 2; index += 1) {
      // Crop the actual 2.75-inch stamps at their unchanged footer positions.
      const png = new PNG({ width: 550, height: 550 });
      PNG.bitblt(printed, png, Math.round((18 + index * 208) * 200 / 72), 2200, 550, 550, 0, 0);
      const pixels = new Uint8ClampedArray(png.data);
      const code = scanQrImage(pixels, png.width, png.height);
      expect(code?.data).toBe(VISIBLE_QR_TEXT);
      expect(code.version).toBeLessThan(40);
      const modules = 17 + 4 * code.version;
      const { topLeftCorner, topRightCorner } = code.location;
      const side = Math.hypot(topRightCorner.x - topLeftCorner.x, topRightCorner.y - topLeftCorner.y);
      expect(side * (modules + 8) / modules / 200).toBeCloseTo(2.75, 1);
      scanned.push(qredPayloadFromPhotoScanResult(pixels, png.width, png.height, code));
    }
    expect(scanned).toEqual(stampedQrValues);
    await expect(verifyQRedSeals(scanned.toReversed(), publicKey)).resolves.toMatchObject({
      status: "VALID", content: expect.stringContaining("Item 45: Received and inspected"),
    });
  });

  it("seals three readable QR parts in a legal footer without losing the signed text", async () => {
    const file = await makeHugeLetterPdfFile();
    const { blob, stampedQrValues } = await sealPdfInBrowser({
      file, privateKey, publicKey, encodingStrategy: "plaintext", pageScalingStrategy: "legal-footer",
    });
    expect(stampedQrValues).toHaveLength(3);
    const printedPdf = await PDFDocument.load(await blob.arrayBuffer());
    expect(printedPdf.getPage(0).getHeight()).toBe(1008);
    await expect(verifyQRedSeals(stampedQrValues.toReversed(), publicKey)).resolves.toMatchObject({
      status: "VALID", content: expect.stringContaining("QRed sealing content needs more than one footer row."),
    });
  });

  it("shrinks page content without changing the source page size when asked", async () => {
    const file = await makeLetterPdfFile();

    const { blob } = await sealPdfInBrowser({
      file,
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
      privateKey,
      publicKey,
    });

    expect(blob.type).toBe("application/pdf");
    expect(stampedQrValues).toEqual(sealResult.seals);
    expect(stampedQrValues[0]).toMatch(/^https:\/\/qred\.org\/#QRED3:/);

    const layout = planQrStampLayout(612, stampedQrValues.length);
    expect(layout.qrSize).toBeGreaterThanOrEqual(177);
    expect(layout.columns * layout.rows).toBeGreaterThanOrEqual(stampedQrValues.length);
    expect(layout.panelWidth).toBeLessThanOrEqual(612 - 36);

    await expect(verifyQRedSeals(stampedQrValues, publicKey)).resolves.toMatchObject({
      status: "VALID",
      content: expect.stringContaining("Dear verifier,"),
    });
  });

  it("keeps printed QR40-capacity stamps large enough to scan after print-to-PDF", async () => {
    const file = await makeLetterPdfFile();

    const { blob, stampedQrValues } = await sealPdfInBrowser({
      file,
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

  it("shrinks the automatic grid while allowing callers to pin stronger correction", () => {
    const autoData = createQRedQrData("small payload");
    const pinnedData = createQRedQrData("small payload", { errorCorrectionLevel: "H" });

    expect(autoData.version).toBe(2);
    expect(autoData.errorCorrectionLevel.bit).toBe(0); // M fits in version 2.
    expect(pinnedData.version).toBe(3);
    expect(pinnedData.errorCorrectionLevel.bit).toBe(2); // Explicit H is honored.
    expect(extractHiddenQRedPayload(autoData.bytes, autoData.version)).toBe("small payload");
    expect(extractHiddenQRedPayload(pinnedData.bytes, pinnedData.version)).toBe("small payload");
  });

  it("generates spec-compatible QRED.ORG alphanumeric QR codes with hidden payload padding that scanners can read", async () => {
    const file = await makeLetterPdfFile();
    const { stampedQrValues } = await sealPdfInBrowser({
      file,
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
