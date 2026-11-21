import { degrees, PageSizes, PDFDocument, rgb } from "pdf-lib";
import { Buffer } from "node:buffer";
import { expect, it, vi } from "vitest";
import { sealPdfInBrowser } from "../pdfClientSeal.js";
import { decodeSeal, verifyQRedSeals } from "../qredVerifier.js";
import { createQRedSeals } from "../qredSealer.js";
import { verifySealCollection } from "../sealCollection.js";
import { decodePhoto } from "../qr/decodePhoto.js";
import { scanPdfPage, scanPdfSeals } from "../verifier/scanPdf.js";
import { renderPdfPage, withPdfDocument } from "./readPdfText.js";
import { renderSealedPdf } from "./renderSealedPdf.js";
import { appendSealSheets } from "./sealSheets.js";
import { sealSheetString } from "../sealFormat.js";
import { createQRedQrSymbol } from "../qredQr.js";
import jsQR from "jsqr";
import { ENTRY_URL } from "./navigationQr.js";
import * as footerScanner from "../qr/footerSealScan.js";

const keys = { privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes",
  publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q" };
const asFile = async pdf => new File([await pdf.save()], "fixture.pdf", { type: "application/pdf" });
const imageOf = (file, number, scale = 2) => withPdfDocument(file, pdf => renderPdfPage(pdf, number, scale, { reference: true }));
const samePixels = (a, b) => a.width === b.width && a.height === b.height && Buffer.from(a.data).equals(Buffer.from(b.data));

it.each([
  ["Letter", PageSizes.Letter, 1], ["A4", PageSizes.A4, 2],
  ["Letter", PageSizes.Letter, 3], ["A4", PageSizes.A4, 4],
  ["Letter", PageSizes.Letter, 5], ["Letter", PageSizes.Letter, 6],
  ["A4", PageSizes.A4, 6], ["Letter", PageSizes.Letter, 7], ["A4", PageSizes.A4, 8],
])("reads every dense seal and the start QR from adaptive %s sheets (%j) with %i codes", async (_name, size, count) => {
  const pdf = await PDFDocument.create();
  pdf.addPage(size).drawText("Fictional seal-sheet layout test", { x: 54, y: 700, size: 12 });
  const entries = [];
  for (let index = 0; index < count; index++) {
    const record = await createQRedSeals({ ...keys, content: `Synthetic record ${index + 1}. ` + "Dense printed seal. ".repeat(140),
      encodingStrategy: "plaintext", timestamp: "2026-01-01T00:00:00.000Z", pageContext: { pageNumber: 1, pageCount: 1 } });
    expect(record.seals).toHaveLength(1);
    const seal = sealSheetString(record.seals[0]);
    expect(createQRedQrSymbol(seal).version).toBeGreaterThanOrEqual(38);
    entries.push({ pageNumber: 1, part: 0, total: 1, seal });
  }
  const result = await appendSealSheets(await pdf.save(), entries, 1);
  expect(result.sheetCount).toBe(Math.ceil(count / 6));
  const file = new Blob([result.bytes], { type: "application/pdf" });
  for (let sheet = 0; sheet < result.sheetCount; sheet++) {
    const expected = entries.slice(sheet * 6, sheet * 6 + 6).map(entry => entry.seal).sort();
    const image = await imageOf(file, sheet + 2);
    // Phone decoding receives only page pixels, with no known QR positions or
    // PDF bounds. This catches the integration risk of changing the layout.
    const photo = decodePhoto({ data: image.data, width: image.width, height: image.height },
      { returnPayload: true, maxDurationMs: 30_000 });
    expect(photo.texts?.sort()).toEqual(expected);
    // Force a partial first pass on a six-code sheet. The real fallback must
    // recover the remaining two instead of treating four as a complete sheet.
    const partialFooter = count === 6 && _name === "A4";
    const scanFooter = footerScanner.scanFooterSeals;
    const spy = partialFooter ? vi.spyOn(footerScanner, "scanFooterSeals").mockImplementationOnce((...args) => {
      const codes = scanFooter(...args);
      expect(codes).toHaveLength(6);
      return codes.slice(0, 4);
    }) : null;
    let scanned;
    try {
      scanned = await scanPdfPage(image, { pageAligned: !partialFooter });
      if (spy) expect(spy).toHaveBeenCalledOnce();
    } finally { spy?.mockRestore(); }
    expect(scanned.limited).toBe(false);
    expect(scanned.seals.sort()).toEqual(expected);
    for (const seal of photo.texts) {
      expect(await verifyQRedSeals([seal], keys.publicKey)).toMatchObject({ status: "VALID", page_number: 1, seal_sheet: true });
    }
    // A normal phone camera must decode the navigation code independently of
    // QRed. Test the actual printed start panel, including its label/background.
    const header = new Uint8ClampedArray(image.width * 160 * 2 * 4);
    header.set(image.data.subarray(0, header.length));
    expect(jsQR(header, image.width, 320)?.data).toBe(ENTRY_URL);
    await withPdfDocument(file, async parsed => {
      const page = await parsed.getPage(sheet + 2);
      const text = (await page.getTextContent()).items.map(item => item.str).join(" ");
      expect(text).toContain("Open QRed.org");
      expect(text).toContain("with your phone camera.");
      expect(text).toContain("or one seal at a time.");
      expect(text).toContain("original document page.");
      expect(text).not.toContain("Original page");
      expect(text.match(/Seal \d+ of \d+/g)).toHaveLength(expected.length);
      // Text bounds also catch header collisions on narrower A4 sheets.
      const instructionItems = (await page.getTextContent()).items.filter(item => item.str && item.transform[5] > size[1] - 150);
      for (const item of instructionItems) expect(item.transform[4] + item.width).toBeLessThanOrEqual(size[0] - 54);
    });
  }
}, 120_000);

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
  const { blob, sheetCount, sheetPages, flattenedFieldCount, sheetSeals } = await sealPdfInBrowser({ file, ...keys, pageScalingStrategy: "seal-sheets" });
  expect([sheetCount, sheetPages, flattenedFieldCount]).toEqual([1, [1, 2], 0]);
  const out = await PDFDocument.load(await blob.arrayBuffer());
  expect(out.getForm().getTextField("Amount").getText()).toBe("12.34");
  expect(out.getPageCount()).toBe(3);
  expect(out.getPage(2).getSize().width).toBeCloseTo(PageSizes.A4[0]);
  const originals = await Promise.all([imageOf(file, 1), imageOf(file, 2)]);
  for (const [index, original] of originals.entries()) expect(samePixels(original, await imageOf(blob, index + 1))).toBe(true);
  const sheet = await imageOf(blob, 3);
  const action = decodePhoto(sheet, { returnPayload: true, maxDurationMs: 30_000 });
  expect(action.texts?.sort()).toEqual([...sheetSeals].sort());
  const verified = await verifySealCollection(action.texts.reverse(), keys.publicKey);
  expect(verified.map(p => [p.status, p.page_number, p.page_count, p.seal_sheet])).toEqual([
    ["VALID", 1, 2, true], ["VALID", 2, 2, true]]);
  expect(verified[0].content).toContain("12.34");
  expect(verified[1].evidence.visual).toBeTruthy();
  const compared = [];
  const summary = await scanPdfSeals(blob, {
    onSeal: (seal, image) => { expect(decodeSeal(seal).seal_sheet).toBe(true); expect(image).toBeNull(); },
    onOriginalPage: (seal, image, { documentId }) => {
      expect(decodeSeal(seal).document_bundle).toBe(true);
      const page = verified.find(p => p.document_id === documentId).page_number;
      expect(samePixels(originals[page - 1], image)).toBe(true);
      compared.push(page);
    },
  });
  expect(compared.sort()).toEqual([1, 2]);
  expect(summary).toMatchObject({ originalPages: [1, 2], missingPages: [], failedPages: [], sealCount: sheetSeals.length });
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
  expect(mixed.sheetPages).toEqual([1, 2]);
  expect(mixed.watermarkLayout.map(Boolean)).toEqual([true, false]);
  expect(samePixels(await imageOf(file, 2), await imageOf(mixed.blob, 2))).toBe(true);
  const onSheet = await scanPdfPage(await imageOf(mixed.blob, 3), { pageAligned: false });
  expect(onSheet.seals).toHaveLength(1);
  expect((await verifySealCollection(onSheet.seals, keys.publicKey)).map(page => [page.status, page.page_number, page.seal_sheet]))
    .toEqual([["VALID", 1, true], ["VALID", 2, true]]);
}, 60_000);

it("backs up the full signed page when only some watermark pieces fit", async () => {
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
  expect(original.seals.length).toBeGreaterThan(0);
  expect(original.seals.length).toBeLessThan(4);
  const pages = await verifySealCollection(sheet.seals, keys.publicKey);
  expect(pages).toHaveLength(1);
  expect(pages[0]).toMatchObject({ status: "VALID", page_number: 1, content: "Original text. ".repeat(210).trim() });
  const all = await verifySealCollection([...sheet.seals, ...record.seals], keys.publicKey);
  expect(all).toHaveLength(1);
  expect(all[0].status).toBe("VALID");
}, 120_000);

it("paginates a dense original across multiple sheets and keeps its original page count", async () => {
  const pdf = await PDFDocument.create(), page = pdf.addPage(PageSizes.Letter);
  page.drawText("Fictional dense document bundle", { x: 54, y: 700 });
  let seed = 13579;
  const content = Array.from({ length: 25_000 }, () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return String.fromCharCode(33 + ((seed >>> 0) % 90));
  }).join("");
  const record = await createQRedSeals({ ...keys, content, maxPageSeals: 4096, pageContext: { pageNumber: 1, pageCount: 1 } });
  const result = await renderSealedPdf({ file: await asFile(pdf), pageSealResults: [record], pagesWithText: [true], pageScalingStrategy: "seal-sheets" });
  expect(result.sheetSeals.length).toBeGreaterThan(6);
  expect(result.sheetCount).toBe(Math.ceil(result.sheetSeals.length / 6));
  expect(result.sheetCount).toBeGreaterThan(1);
  const output = await PDFDocument.load(await result.blob.arrayBuffer());
  expect(output.getPageCount()).toBe(1 + result.sheetCount);
  const scans = [];
  for (let number = output.getPageCount(); number >= 2; number--) {
    const decoded = await scanPdfPage(await imageOf(result.blob, number), { pageAligned: false });
    scans.push(...decoded.seals);
  }
  expect(scans.sort()).toEqual([...result.sheetSeals].sort());
  expect(await verifySealCollection(scans, keys.publicKey)).toMatchObject([{ status: "VALID", page_number: 1, page_count: 1, content }]);
}, 180_000);
