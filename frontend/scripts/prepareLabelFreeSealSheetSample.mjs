// Render a real document-bundle test with the proposed label-free appendix.
// Run from frontend: node node_modules/vite-node/vite-node.mjs scripts/prepareLabelFreeSealSheetSample.mjs
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PDFDocument, PageSizes, StandardFonts, rgb } from "pdf-lib";
import { PNG } from "pngjs";
import { sealPdfInBrowser } from "../src/pdfClientSeal.js";
import { withPdfDocument, renderPdfPage } from "../src/pdf/readPdfText.js";
import { decodePhoto } from "../src/qr/decodePhoto.js";
import { verifySealCollection } from "../src/sealCollection.js";
import { planSealSheetLayout } from "../src/pdf/sealSheetLayout.js";
import { createQRedQrSymbol } from "../src/qredQr.js";

const out = resolve(process.env.QRED_SAMPLE_OUTPUT || "../print-seal-sheet-samples");
await mkdir(out, { recursive: true });
const keys = {
  privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes",
  publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q",
};
let randomState = 0x73f195ab;
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function reference() {
  return Array.from({ length: 68 }, () => {
    randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5;
    return alphabet[(randomState >>> 0) % alphabet.length];
  }).join("");
}

const source = await PDFDocument.create();
const regular = await source.embedFont(StandardFonts.Helvetica);
const bold = await source.embedFont(StandardFonts.HelveticaBold);
const mono = await source.embedFont(StandardFonts.Courier);
for (let number = 1; number <= 6; number++) {
  const page = source.addPage(PageSizes.Letter);
  page.drawText("Fictional archive validation log", { x: 54, y: 738, font: bold, size: 17 });
  page.drawText("SYNTHETIC SCANNER TEST - PUBLIC DEMO SIGNING KEY", { x: 54, y: 716, font: regular, size: 9 });
  page.drawText(`Original page ${number} of 6`, { x: 54, y: 688, font: bold, size: 11 });
  page.drawText("Generated reference values exercise a full sheet of compressed document seals.",
    { x: 54, y: 669, font: regular, size: 9 });
  for (let row = 0; row < 30; row++) {
    const index = String((number - 1) * 30 + row + 1).padStart(4, "0");
    page.drawText(`${index}  Ref: ${reference()}`, { x: 54, y: 642 - row * 12, font: mono, size: 8.8 });
  }
  page.drawText("All records are fictional. This public test key proves no real issuer identity.",
    { x: 54, y: 54, font: regular, size: 9, color: rgb(.35, .35, .35) });
}
const sourceBytes = await source.save();
const result = await sealPdfInBrowser({ file: new File([sourceBytes], "fictional-archive.pdf", { type: "application/pdf" }),
  ...keys, pageScalingStrategy: "seal-sheets" });
console.log(JSON.stringify({ phase: "generated", seals: result.sheetSeals.length, bytes: result.bundle.payload_bytes,
  sheets: result.sheetCount, originalPages: 6 }));
assert.equal(result.sheetSeals.length, 6, "This example must exercise the six-code maximum.");
assert.equal(result.sheetCount, 1);
const pdfPath = `${out}/QRed_Label_Free_Seal_Sheet_Test.pdf`;
await writeFile(pdfPath, Buffer.from(await result.blob.arrayBuffer()));

const scale = 200 / 72;
const { image, text } = await withPdfDocument(result.blob, async pdf => ({
  image: await renderPdfPage(pdf, 7, scale, { reference: true }),
  text: (await (await pdf.getPage(7)).getTextContent()).items.map(item => item.str).join(" "),
}));
assert.ok(text.includes("Seal sheet 1 of 1"));
assert.ok(!/Seal \d+ of \d+/.test(text));
assert.ok(!text.includes("Original page"));
assert.ok(!text.includes("Follow QRed's prompts"));
const preview = new PNG({ width: image.width, height: image.height });
preview.data = Buffer.from(image.data);
await writeFile(`${out}/QRed_Label_Free_Seal_Sheet_Test.png`, PNG.sync.write(preview));

// Feed the complete rendered sheet to the same photo decoder as the app.
// Supply no QR crop, location, or payload hint.
const start = performance.now();
const action = decodePhoto(image, { returnPayload: true, maxDurationMs: 60000 });
const scanned = action.texts || (action.text ? [action.text] : []);
assert.deepEqual([...scanned].sort(), [...result.sheetSeals].sort(), "Recover every QR from the whole rendered sheet.");
const pages = await verifySealCollection(scanned.reverse(), keys.publicKey);
assert.deepEqual(pages.map(page => [page.page_number, page.status]),
  Array.from({ length: 6 }, (_, index) => [index + 1, "VALID"]));
for (let i = 0; i < 6; i++) assert.equal(pages[i].content, JSON.parse(result.pageSealResults[i].payload_json).content);
const report = { source: "fictional archive validation log", original_pages: 6, appended_sheets: 1,
  codes_generated: result.sheetSeals.length, codes_decoded: scanned.length, authenticated_pages: pages.length,
  pixel_dimensions: [image.width, image.height], render_dpi: 200,
  scan_and_verification_ms: Math.round(performance.now() - start), bundle_bytes: result.bundle.payload_bytes,
  qr_versions: result.sheetSeals.map(seal => createQRedQrSymbol(seal).version),
  qr_ink_points: planSealSheetLayout(...PageSizes.Letter, result.sheetSeals.map(seal => createQRedQrSymbol(seal).modules.size))[0].width,
  test_scope: "Whole rendered PDF sheet decoded and signatures verified; no physical printer or phone camera involved." };
await writeFile(`${out}/test-results.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
