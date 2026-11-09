import { degrees, PageSizes, PDFDocument, rgb } from "pdf-lib";
import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import { sealPdfInBrowser } from "../pdfClientSeal.js";
import { decodeSeal, verifyQRedSeals } from "../qredVerifier.js";
import { createQRedSeals } from "../qredSealer.js";
import { verifySealCollection } from "../sealCollection.js";
import { decodePhoto } from "../qr/decodePhoto.js";
import { scanPdfPage, scanPdfSeals } from "../verifier/scanPdf.js";
import { renderPdfPage, withPdfDocument } from "./readPdfText.js";
import { renderSealedPdf } from "./renderSealedPdf.js";

const keys = { privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes",
  publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q" };
const asFile = async pdf => new File([await pdf.save()], "fixture.pdf", { type: "application/pdf" });
const imageOf = (file, number, scale = 2) => withPdfDocument(file, pdf => renderPdfPage(pdf, number, scale, { reference: true }));
const samePixels = (a, b) => a.width === b.width && a.height === b.height && Buffer.from(a.data).equals(Buffer.from(b.data));

it("preserves original pages, forms and annotations and reads a whole sheet before comparing each original", async () => {
  const pdf = await PDFDocument.create();
  const front = pdf.addPage(PageSizes.A4);
  front.drawText("DRAFT", { x: 130, y: 200, size: 56, rotate: degrees(35), color: rgb(.82, .82, .82) });
  const field = pdf.getForm().createTextField("Amount");
  field.setText("12.34");
  field.addToPage(front, { x: 90, y: 700, width: 150, height: 25 });
  const second = pdf.addPage([390, 510]);
  second.drawCircle({ x: 140, y: 190, size: 30 });
  second.setCropBox(21, 33, 340, 420);
  second.setRotation(degrees(90));
  const file = await asFile(pdf);
  const { blob, sheetCount, sheetPages, flattenedFieldCount } = await sealPdfInBrowser({ file, ...keys, pageScalingStrategy: "seal-sheets" });
  expect([sheetCount, sheetPages, flattenedFieldCount]).toEqual([1, [1, 2], 0]);
  const out = await PDFDocument.load(await blob.arrayBuffer());
  expect(out.getForm().getTextField("Amount").getText()).toBe("12.34");
  expect(out.getPageCount()).toBe(3);
  expect(out.getPage(2).getSize().width).toBeCloseTo(PageSizes.A4[0]);
  const originals = await Promise.all([imageOf(file, 1), imageOf(file, 2)]);
  for (const [index, original] of originals.entries()) expect(samePixels(original, await imageOf(blob, index + 1))).toBe(true);
  const sheet = await imageOf(blob, 3);
  const action = decodePhoto(sheet, { returnPayload: true, maxDurationMs: 30_000 });
  expect(action.texts).toHaveLength(2);
  const verified = await verifySealCollection(action.texts.reverse(), keys.publicKey);
  expect(verified.map(p => [p.status, p.page_number, p.page_count, p.seal_sheet])).toEqual([
    ["VALID", 1, 2, true], ["VALID", 2, 2, true]]);
  expect(verified[0].content).toContain("12.34");
  expect(verified[1].evidence.visual).toBeTruthy();
  const compared = [];
  const summary = await scanPdfSeals(blob, {
    onSeal: (seal, image) => { expect(decodeSeal(seal).seal_sheet).toBe(true); expect(image).toBeNull(); },
    onOriginalPage: (seal, image) => {
      const page = verified.find(p => p.document_id === decodeSeal(seal).document_id).page_number;
      expect(samePixels(originals[page - 1], image)).toBe(true);
      compared.push(page);
    },
  });
  expect(compared.sort()).toEqual([1, 2]);
  expect(summary).toMatchObject({ originalPages: [1, 2], missingPages: [], failedPages: [], sealCount: 2 });
}, 120_000);

it("watermarks by default and adds sheets only for overflow", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage(PageSizes.Letter).drawText("Pay on Friday", { x: 60, y: 705, size: 14 });
  const allFit = await sealPdfInBrowser({ ...keys, file: await asFile(pdf) });
  expect(allFit.sheetCount).toBe(0);
  expect((await PDFDocument.load(await allFit.blob.arrayBuffer())).getPageCount()).toBe(1);
  pdf.addPage(PageSizes.Letter).drawCircle({ x: 80, y: 80, size: 40 });
  const file = await asFile(pdf);
  const mixed = await sealPdfInBrowser({ ...keys, file });
  expect(mixed.sheetPages).toEqual([2]);
  expect(mixed.watermarkLayout.map(Boolean)).toEqual([true, false]);
  expect(samePixels(await imageOf(file, 2), await imageOf(mixed.blob, 2))).toBe(true);
  const onSheet = await scanPdfPage(await imageOf(mixed.blob, 3), { pageAligned: false });
  expect(onSheet.seals).toHaveLength(1);
  expect(await verifyQRedSeals(onSheet.seals, keys.publicKey)).toMatchObject({ status: "VALID", page_number: 2, seal_sheet: true });
}, 60_000);

it("splits one multipart record between its original and the appendix without duplicates", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 340]).drawText("Page with little room", { x: 25, y: 306, size: 10 });
  const record = await createQRedSeals({ ...keys, content: "Original text. ".repeat(210), encodingStrategy: "plaintext",
    preferFourQrPage: true, pageContext: { pageNumber: 1, pageCount: 1 } });
  expect(record.seals).toHaveLength(4);
  const result = await renderSealedPdf({ file: await asFile(pdf), pageSealResults: [record], pagesWithText: [true], pageScalingStrategy: "watermark-sheets" });
  expect(result.watermarkLayout[0].boxes.length).toBeGreaterThan(0);
  expect(result.watermarkLayout[0].boxes.length).toBeLessThan(4);
  const original = await scanPdfPage(await imageOf(result.blob, 1));
  const sheet = await scanPdfPage(await imageOf(result.blob, 2), { pageAligned: false });
  const all = [...sheet.seals, ...original.seals];
  expect(all.map(s => decodeSeal(s).chunk_number).sort()).toEqual([0, 1, 2, 3]);
  expect(await verifyQRedSeals(sheet.seals, keys.publicKey)).toMatchObject({ status: "INCOMPLETE" });
  expect(await verifyQRedSeals(all, keys.publicKey)).toMatchObject({ status: "VALID", page_number: 1 });
}, 120_000);

it("paginates a dense original across multiple sheets and keeps its original page count", async () => {
  const pdf = await PDFDocument.create(), page = pdf.addPage(PageSizes.Letter);
  for (let i = 0; i < 100; i++) page.drawText("Appendix pagination ".repeat(7), { x: 50, y: 740 - i * 7, size: 5 });
  const result = await sealPdfInBrowser({ ...keys, file: await asFile(pdf), pageScalingStrategy: "seal-sheets", encodingStrategy: "plaintext" });
  expect(result.pageSealStrings[0].length).toBeGreaterThan(4);
  expect(result.sheetCount).toBe(2);
  const output = await PDFDocument.load(await result.blob.arrayBuffer());
  expect(output.getPageCount()).toBe(3);
  const scans = [];
  for (const number of [3, 2]) {
    const decoded = await scanPdfPage(await imageOf(result.blob, number), { pageAligned: false });
    scans.push(...decoded.seals);
  }
  expect(scans.sort()).toEqual([...result.pageSealStrings[0]].sort());
  expect(await verifyQRedSeals(scans, keys.publicKey)).toMatchObject({ status: "VALID", page_number: 1, page_count: 1 });
}, 120_000);
