import { PDFDocument, degrees } from "pdf-lib";
import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import { createQRedSeals } from "../qredSealer.js";
import { qrPngBytes } from "../pdfClientSeal.js";
import { verifySealCollection } from "../sealCollection.js";
import { pdfScanSummary, scanPdfSeals } from "./scanPdf.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";

async function fixture() {
  const groups = await Promise.all(["Example multipart content. ".repeat(120), "Second page"].map((content, index) =>
    createQRedSeals({ content, privateKey, publicKey, encodingStrategy: "plaintext",
      timestamp: "2026-10-24T12:00:00Z",
      pageContext: { pageNumber: index + 1, pageCount: 2, documentRoot: "a1".repeat(32) } })));
  expect(groups[0].seals.length).toBeGreaterThan(1);
  const pdf = await PDFDocument.create();
  for (let index = 0; index < groups.length; index++) {
    const page = pdf.addPage([612, 792]);
    const values = index === 0 ? groups[index].seals : [groups[index].seals[0], groups[index].seals[0]];
    for (let part = 0; part < values.length; part++) {
      const image = await pdf.embedPng(await qrPngBytes(values[part]));
      page.drawImage(image, { x: 30 + part * 270, y: 40, width: 250, height: 250 });
    }
    page.drawImage(await pdf.embedPng(await QRCode.toBuffer(index ? "https://qred.org/" : "https://example.org/ordinary")),
      { x: 420, y: 600, width: 100, height: 100 });
    if (index === 1) { page.setCropBox(12, 12, 588, 768); page.setRotation(degrees(90)); }
  }
  pdf.addPage([300, 300]);
  // A payload in metadata is not a visible seal, and must never be collected.
  pdf.setSubject(groups[0].seals[0]);
  return { file: new File([await pdf.save()], "synthetic-verification.pdf", { type: "application/pdf" }), groups };
}

describe("loading PDF seals locally", () => {
  it("reads every visible QR part across pages, skips unrelated codes, deduplicates, and reports an unsealed page", async () => {
    const { file, groups } = await fixture();
    const seals = [], progress = [];
    const summary = await scanPdfSeals(file, {
      onSeal: (seal, image) => { seals.push(seal); expect(image.data.length).toBe(image.width * image.height * 4); },
      onProgress: value => progress.push(value.pageNumber),
    });
    expect(seals).toHaveLength(groups.flatMap(group => group.seals).length);
    expect(new Set(seals)).toEqual(new Set(groups.flatMap(group => group.seals)));
    expect(summary).toEqual({ pageCount: 3, pagesWithSeals: 2, sealCount: seals.length, missingPages: [3], failedPages: [] });
    expect(progress).toEqual([1, 2, 3]);
    const results = await verifySealCollection(seals, publicKey);
    expect(results.map(result => [result.status, result.page_number])).toEqual([["VALID", 1], ["VALID", 2]]);
    expect(pdfScanSummary(summary)).toContain("No readable seal on PDF page(s): 3.");
  }, 90000);

  it("stops before collecting more QR parts when cancelled", async () => {
    const { file } = await fixture();
    const controller = new AbortController();
    const seals = [];
    await expect(scanPdfSeals(file, { signal: controller.signal,
      onSeal: seal => { seals.push(seal); controller.abort(); },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(seals).toHaveLength(1);
  }, 30000);

  it("rejects a malformed PDF without returning a verification result", async () => {
    await expect(scanPdfSeals(new File(["not a PDF"], "broken.pdf"))).rejects.toThrow();
  });
});
