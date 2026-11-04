import { describe, expect, it } from "vitest";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readPdfPagesWithEvidence } from "./readPdfText.js";
import { PDFDocument, degrees } from "pdf-lib";
import { sealPdfInBrowser, prepareAccountPdfSeal } from "../pdfClientSeal.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { decodePageEvidence } from "../pageEvidence.js";
// Do not depend on a runner's generic sans-serif fallback. The locked PDF.js
// package already ships this font, so every OCR fixture has the same glyphs.
const require = createRequire(import.meta.url);
if (!GlobalFonts.registerFromPath(join(dirname(require.resolve("pdfjs-dist/package.json")),
  "standard_fonts/LiberationSans-Regular.ttf"), "QRedOcrFixture")) throw new Error("OCR fixture font could not load");
const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";
async function scanPdf(native = false) {
  const canvas = createCanvas(600, 300), context = canvas.getContext("2d");
  context.fillStyle = "white"; context.fillRect(0, 0, 600, 300);
  context.fillStyle = "black"; context.font = "32px QRedOcrFixture";
  context.fillText("Account 123456", 30, 65); context.fillText("Amount 50.00", 30, 120);
  const pdf = await PDFDocument.create(), page = pdf.addPage([600, 700]);
  const image = await pdf.embedPng(canvas.toBuffer("image/png"));
  page.drawImage(image, { x: 0, y: 300, width: 600, height: 300 });
  if (native) page.drawText("Native record", { x: 30, y: 650, size: 18 });
  return new File([await pdf.save()], "synthetic-scan.pdf", { type: "application/pdf" });
}
describe("signed OCR from original PDF image", () => {
  it("signs scanned text separately, uses a footer and verifies its OCR", async () => {
    const file = await scanPdf();
    const result = await sealPdfInBrowser({ file, privateKey, publicKey });
    const verified = await verifyQRedSeals(result.pageSealStrings[0], publicKey);
    expect(verified.status).toBe("VALID");
    expect(verified.evidence.text).toBe("");
    expect(verified.evidence.ocr.engine).toBe("tesseract-eng-v1");
    expect(verified.evidence.ocr.lines.map(line => line.text).join("\n")).toContain("Account 123456");
    expect(verified.evidence.ocr.lines.map(line => line.text).join("\n")).toContain("Amount 50.00");
    expect(result.footerPages).toContain(1);
    expect(verified.evidence.ocr.lines.map(line => line.text).join("\n")).not.toMatch(/QRed|verify/i);
  }, 30000);
  it("includes both native and machine readings in account commitments before sign-in", async () => {
    const result = await prepareAccountPdfSeal({ file: await scanPdf(true), pageScalingStrategy: "legal-footer" });
    const evidence = decodePageEvidence(result.pages[0].content);
    expect(evidence.text).toBe("Native record");
    expect(evidence.ocr.lines.map(line => line.text).join("\n")).toContain("Amount 50.00");
    expect(result.ocrPages).toHaveLength(1);
  }, 30000);
});

it("reads the original visible crop in its rotated coordinate frame", async () => {
  const pdf = await PDFDocument.load(await (await scanPdf()).arrayBuffer());
  const page = pdf.getPage(0);
  page.setCropBox(0, 300, 600, 300); page.setRotation(degrees(90));
  const file = new File([await pdf.save()], "rotated-crop.pdf", { type: "application/pdf" });
  let dimensions;
  const ocr = { engine: "tesseract-eng-v1", lines: [{ text: "machine reading", x: .1, y: .2, width: .4, height: .1, confidence: 50 }] };
  const pages = await readPdfPagesWithEvidence(file, page => page, { ocrReader: {
    read: async (image, width, height) => { dimensions = [width, height]; expect(image.length).toBeGreaterThan(0); return ocr; },
  } });
  expect(dimensions).toEqual([900, 1800]);
  expect(pages[0]).toMatchObject({ width: 300, height: 600, text: "", ocr });
});
