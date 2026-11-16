// Run with vite-node from frontend. All document content is generated here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { sealPdfInBrowser } from "../src/pdfClientSeal.js";
import { createQRedSeals } from "../src/qredSealer.js";
import { verifyQRedSeals } from "../src/qredVerifier.js";
import { stampWatermarks } from "../src/pdf/watermark.js";
import { pageWatermarkRegions } from "../src/qr/pageAlignedScan.js";

assert(process.argv[2], "Pass a directory for the generated workshop documents");
const output = resolve(process.argv[2]);
const fixedTime = "2031-03-04T12:00:00.000Z";
const NativeDate = Date;
// Keep the issue time and signed bytes stable across fixture regeneration.
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [fixedTime])); }
  static now() { return NativeDate.parse(fixedTime); }
};
// Public test seed already used in generateCompactFixtures.mjs.
const keys = {
  privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=",
  publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=",
};
const width = 612, height = 792;
const charcoal = rgb(0.11, 0.17, 0.22), blue = rgb(0.12, 0.29, 0.36);
const light = rgb(0.80, 0.84, 0.85), pale = rgb(0.92, 0.94, 0.94);
const digest = value => createHash("sha256").update(value).digest("hex");

async function newDocument(title) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setAuthor("QRed test fixtures");
  return {
    pdf,
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };
}

function pageWriter(doc, title, subtitle) {
  const page = doc.pdf.addPage([width, height]);
  const text = (value, x, y, size = 11, font = doc.regular, color = charcoal) =>
    page.drawText(value, { x, y, size, font, color });
  const line = (y, color = light) => page.drawLine({
    start: { x: 52, y }, end: { x: 560, y }, color, thickness: 0.65 });
  text("LANTERN BENCH WORKSHOP", 52, 743, 12, doc.bold, blue);
  text(title, 52, 699, 30, doc.bold);
  text(subtitle, 53, 673, 12);
  line(654, blue);
  return { page, text, line };
}

async function statement(inspectionYear) {
  const doc = await newDocument("Lantern Bench Workshop supply statement");
  const items = [
    ["Birch rail", 3, 1850], ["Pivot sleeve", 6, 325], ["Ceramic spacer", 4, 275],
    ["Copper shim", 8, 160], ["Bench clamp", 2, 2460], ["Pin set", 5, 440],
    ["Maple stop", 4, 660], ["Corner brace", 6, 380], ["Spacer roll", 2, 920],
    ["Lock washer", 12, 85], ["Clamp pad", 4, 215], ["Spring latch", 2, 1265],
  ];
  const money = cents => (cents / 100).toFixed(2);
  const total = items.reduce((sum, [,qty,unit]) => sum + qty * unit, 0);
  const detail = pageWriter(doc, "Supply statement", "Batch LB-0418   /   Bench stock replenishment");
  detail.text("Issue date", 52, 622, 10, doc.bold);
  detail.text("March 4, 2031", 52, 604);
  detail.text("Stockroom", 285, 622, 10, doc.bold);
  detail.text("Assembly bay C", 285, 604);
  detail.page.drawRectangle({ x: 52, y: 555, width: 508, height: 24, color: pale });
  for (const [label, x] of [["Material", 62], ["Units", 287], ["Unit price", 360], ["Line total", 472]]) {
    detail.text(label, x, 563, 10, doc.bold);
  }
  items.forEach(([name, qty, price], i) => {
    const y = 536 - 27 * i;
    detail.text(name, 62, y);
    detail.text(String(qty), 294, y);
    detail.text(money(price), 362, y);
    detail.text(money(qty * price), 476, y);
    detail.line(y - 9);
  });
  detail.text("Materials total", 333, 190, 12, doc.bold);
  detail.text(money(total), 475, 190, 12, doc.bold);
  detail.text("SYNTHETIC TEST DOCUMENT", 52, 63, 9, doc.bold, blue);
  detail.text("Page 1 of 2", 505, 63, 9);

  const audit = pageWriter(doc, "Stock reconciliation", "Batch LB-0418   /   Closeout");
  audit.text("Inspection record", 52, 608, 17, doc.bold);
  for (const [i, [label,value]] of [
    ["Record number", "QC-0064"], ["Parts received", "12 line items"],
    ["Materials total", money(total)], ["Inventory location", "Assembly bay C"],
    ["Next inspection year", inspectionYear],
  ].entries()) {
    const y = 561 - i * 45;
    audit.text(label, 62, y);
    audit.text(value, 341, y, 13, doc.bold);
    audit.line(y - 14);
  }
  audit.text("Release note", 52, 291, 14, doc.bold);
  audit.text("Keep the counted parts together until the next inspection.", 52, 263);
  audit.text("SYNTHETIC TEST DOCUMENT", 52, 63, 9, doc.bold, blue);
  audit.text("Page 2 of 2", 505, 63, 9);
  return doc.pdf;
}

// The long, deterministic stock tags force a four-piece legacy seal.
async function partsManifest() {
  const doc = await newDocument("Lantern Bench Workshop lot register");
  const title = "Lot register", subtitle = "Run RG-062   /   Inspection samples";
  const { text, line } = pageWriter(doc, title, subtitle);
  const signedLines = ["LANTERN BENCH WORKSHOP", title, subtitle];
  const heads = ["Rack A", "Rack B", "Rack C", "Rack D"];
  heads.forEach((head, col) => text(head, 52 + 130 * col, 622, 11, doc.bold, blue));
  signedLines.push(heads.join(" "));
  for (let row = 0; row < 35; row++) {
    const tags = heads.map((_, col) => digest(`Lantern test lot ${row}/${col}`).slice(0, 22).toUpperCase());
    const y = 598 - 14 * row;
    tags.forEach((tag, col) => text(tag, 52 + 130 * col, y, 8, doc.mono));
    if (row % 5 === 4) line(y - 4);
    signedLines.push(tags.join(" "));
  }
  text("SYNTHETIC TEST DOCUMENT", 52, 63, 9, doc.bold, blue);
  signedLines.push("SYNTHETIC TEST DOCUMENT");
  const result = await createQRedSeals({ ...keys, content: signedLines.join("\n"), timestamp: fixedTime,
    encodingStrategy: "plaintext", preferFourQrPage: true, pageContext: { pageNumber: 1, pageCount: 1 } });
  assert.equal(result.seals.length, 4);
  const boxes = pageWatermarkRegions(4, { width, height }).map(region => ({
    x: region.x * width, y: (1 - region.y - region.height) * height,
    width: region.width * width, height: region.height * height,
  }));
  await stampWatermarks(doc.pdf, [{ boxes, pageAligned: true, gray: 0.87 }], [result]);
  return { pdf: doc.pdf, seals: result.seals };
}

await mkdir(output, { recursive: true });
const source = await (await statement("2037")).save();
const result = await sealPdfInBrowser({
  file: new File([source], "Workshop_Statement.pdf", { type: "application/pdf" }), ...keys,
  encodingStrategy: "automatic", pageScalingStrategy: "watermark",
});
assert.deepEqual(result.footerPages, [], "Statement must retain the watermarks on its original pages");
await writeFile(join(output, "Workshop_Statement.pdf"), Buffer.from(await result.blob.arrayBuffer()));
// Use the SAME signed pages. Re-signing the edit would make this a different test.
const altered = await statement("2032");
await stampWatermarks(altered, result.watermarkLayout, result.pageSealResults);
await writeFile(join(output, "Workshop_Statement_Changed.pdf"), await altered.save());
const manifest = await partsManifest();
await writeFile(join(output, "Workshop_Lot_Register.pdf"), await manifest.pdf.save());
const expected = {};
for (const [name, seals] of [
  ["statement-1", result.pageSealStrings[0]],
  ["statement-2", result.pageSealStrings[1]],
  ["lot-register", manifest.seals],
]) {
  const verified = await verifyQRedSeals(seals, keys.publicKey);
  assert.equal(verified.status, "VALID");
  expected[name] = {
    page: verified.page_number,
    pages: verified.page_count,
    parts: seals.length,
    pageHash: verified.page_hash,
    sealDigests: seals.map(digest).sort(),
  };
}
await writeFile(join(output, "expected.json"), JSON.stringify(expected, null, 2) + "\n");
await writeFile(join(output, "demo-public-key.txt"), keys.publicKey + "\n");
console.log(JSON.stringify(expected));
