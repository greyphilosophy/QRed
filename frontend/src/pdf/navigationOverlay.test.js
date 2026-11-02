import { expect, it } from "vitest";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { createQRedSeals } from "../qredSealer.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { scanQrImage } from "../qr/scanQrImage.js";
import { qredPayloadFromScanResult } from "../qr/qrPayload.js";
import { scanPdfPage } from "../verifier/scanPdf.js";
import { renderSealedPdf } from "./renderSealedPdf.js";
import { extractPdfText } from "../pdfClientSeal.js";
import { renderPdfPage, withPdfDocument } from "./readPdfText.js";
import { ENTRY_URL, checkWatermarks } from "./watermark.js";
import { simulatePrintPhoto } from "./watermarkPreflight.js";
import { planFooterLayout } from "./qrLayout.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";

async function fixture(count, margin) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const lines = Array(count === 4 ? 80 : 3).fill("Navigation overlay signed-page challenge.");
  // Isolate the optional overlay from dense foreground obstruction. The long
  // synthetic payload exercises four chunks; source-text sealing and dense
  // page fallbacks are covered by pdfWatermark.test.js.
  lines.slice(0, 3).forEach((line, index) => page.drawText(line, {
    x: 90, y: 690 - index * 14, size: 10,
  }));
  if (margin === 36) {
    page.drawText("Narrow source margin", { x: 28, y: 160, size: 8 });
    lines.push("Narrow source margin");
  }
  const content = lines.join("\n");
  const signed = await createQRedSeals({ privateKey, publicKey, content,
    encodingStrategy: "plaintext", timestamp: "2026-10-31T12:00:00Z",
    pageContext: { pageNumber: 1, pageCount: 1 }, preferFourQrPage: true });
  expect(signed.seals).toHaveLength(count);
  const file = new File([await pdf.save()], "navigation-overlay.pdf", { type: "application/pdf" });
  return { file, content, signed };
}

function crop(image, box) {
  const left = Math.floor(box.x * image.scale);
  const top = Math.floor((image.bounds.height - box.y - box.height) * image.scale);
  const width = Math.ceil(box.width * image.scale), height = Math.ceil(box.height * image.scale);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const offset = ((top + row) * image.width + left) * 4;
    data.set(image.data.subarray(offset, offset + width * 4), row * width * 4);
  }
  return { data, width, height };
}

function photograph(image) {
  const softened = simulatePrintPhoto(image);
  const width = image.width + 80, height = image.height + 80;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([55, 55, 55, 255], i);
  for (let row = 0; row < image.height; row++) {
    data.set(softened.data.subarray(row * image.width * 4, (row + 1) * image.width * 4),
      ((row + 40) * width + 40) * 4);
  }
  // Optical paper boundary only: no PDF bounds, QR locations or expected bytes.
  return { data, width, height };
}

it.each([[1, 54], [1, 36], [4, 54], [4, 36]])(
  "keeps navigation and all %i signed chunks readable with a %ipt margin", async (count, margin) => {
    const { file, content, signed } = await fixture(count, margin);
    const result = await renderSealedPdf({ file, pageSealResults: [signed], pagesWithText: [true] });
    expect(result.footerPages, JSON.stringify(result.footerReasons)).toEqual([]);
    const layout = result.watermarkLayout[0];
    expect(layout.pageAligned).toBe(true);
    expect(layout.boxes).toHaveLength(count);
    expect(layout.boxes[0].x).toBeCloseTo(margin);
    expect(layout.entry).toBeTruthy();
    expect(layout.boxes.some(box => layout.entry.x < box.x + box.width &&
      layout.entry.x + layout.entry.width > box.x && layout.entry.y < box.y + box.height &&
      layout.entry.y + layout.entry.height > box.y)).toBe(true);
    await withPdfDocument(result.blob, async pdf => {
      const image = await renderPdfPage(pdf, 1);
      const navigation = crop(image, layout.entry);
      expect(scanQrImage(navigation.data, navigation.width, navigation.height,
        { tryWatermark: false })?.data).toBe(ENTRY_URL);
      const scanned = await scanPdfPage(photograph(image));
      expect(new Set(scanned.seals)).toEqual(new Set(signed.seals));
      await expect(verifyQRedSeals(scanned.seals, publicKey))
        .resolves.toMatchObject({ status: "VALID", content });
    });
  }, 90000);

it("rejects an unreadable navigation overlay even when its signed watermark still decodes", async () => {
  const { file, signed } = await fixture(1, 54);
  const result = await renderSealedPdf({ file, pageSealResults: [signed], pagesWithText: [true] });
  const layout = result.watermarkLayout[0];
  expect(layout.entry).toBeTruthy();
  const pdf = await PDFDocument.load(await result.blob.arrayBuffer());
  pdf.getPage(0).drawRectangle({ ...layout.entry, color: rgb(1, 1, 1) });
  const bytes = await pdf.save();
  await withPdfDocument(new Blob([bytes]), async document => {
    const scanned = await scanPdfPage(await renderPdfPage(document, 1));
    expect(scanned.seals).toEqual(signed.seals);
  });
  const reasons = [];
  expect(await checkWatermarks(bytes, [layout], [signed], {
    onFailure: (_index, reason) => reasons.push(reason),
  })).toEqual([0]);
  expect(reasons).toEqual(["The small verification-link QR could not be read."]);
}, 60000);

it("reserves readable instruction text above a full-width three-code footer", async () => {
  const content = "Footer caption placement. ".repeat(240).trimEnd();
  const signed = await createQRedSeals({ privateKey, publicKey, content,
    encodingStrategy: "plaintext", timestamp: "2026-10-31T12:00:00Z",
    pageContext: { pageNumber: 1, pageCount: 1 } });
  expect(signed.seals).toHaveLength(3);
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText("Synthetic footer layout example", { x: 72, y: 700, size: 12 });
  const file = new File([await pdf.save()], "three-part-footer.pdf", { type: "application/pdf" });
  const result = await renderSealedPdf({ file, pageSealResults: [signed],
    pagesWithText: [true], pageScalingStrategy: "legal-footer" });
  expect((await extractPdfText(result.blob)).match(/Verify at qred\.org/g)).toHaveLength(1);
  await withPdfDocument(result.blob, async document => {
    const image = await renderPdfPage(document, 1, 300 / 72);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const layout = planFooterLayout(612, 3, { legal: true, navigation: true,
      captionWidth: font.widthOfTextAtSize("Verify at qred.org", 9) });
    const { items } = await (await document.getPage(1)).getTextContent();
    const caption = items.find(item => item.str === "Verify at qred.org");
    expect(caption.transform[5]).toBeGreaterThan(layout.qrOffsetY + layout.gridHeight + 3);
    // Dense conventional footer codes can be framed individually. Verify
    // all three actual printed rasters at 300 DPI, including their quiet zones.
    const recovered = signed.seals.map((_seal, index) => {
      const qr = crop(image, { x: layout.qrOffsetX + index * (layout.qrSize + layout.gap),
        y: layout.qrOffsetY, width: layout.qrSize, height: layout.qrSize });
      return qredPayloadFromScanResult(scanQrImage(qr.data, qr.width, qr.height));
    });
    expect(recovered).toEqual(signed.seals);
    const entry = crop(image, layout.entry);
    expect(scanQrImage(entry.data, entry.width, entry.height, { tryWatermark: false })?.data).toBe(ENTRY_URL);
    await expect(verifyQRedSeals(recovered, publicKey)).resolves.toMatchObject({ status: "VALID", content });
  });
}, 60000);
