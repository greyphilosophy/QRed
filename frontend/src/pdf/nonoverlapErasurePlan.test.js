import { beforeAll, expect, it } from "vitest";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createQRedSeals } from "../qredSealer.js";
import { qrPayloadBytes } from "../sealFormat.js";
import { planNonoverlapErasure, drawNonoverlapErasurePlan } from "./nonoverlapErasurePlan.js";
import { withPdfDocument, renderPdfPage } from "./readPdfText.js";
import { drawQrSymbol } from "./qrDrawing.js";
import { scanErasureSeals, erasureCandidates } from "../qr/scanErasureSeals.js";
import { decodePhotoWithErasure } from "../qr/decodePhotoWithErasure.js";
import { recoverErasureRecord } from "../erasureTransport.js";
import { verifySealCollection } from "../sealCollection.js";
import { scanPdfSeals } from "../verifier/scanPdf.js";
const keys = { privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=", publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=" };
let source, original, record, plan;
beforeAll(async () => {
  const pdf = await PDFDocument.create(), page = pdf.addPage([612, 792]), font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Invoice 1042", { x: 72, y: 700, size: 18, font });
  page.drawText("Amount 50.00", { x: 72, y: 660, size: 18, font });
  // Gray, colored, very faint and antialiased source marks must survive too.
  page.drawRectangle({ x: 31, y: 471.3, width: 550, height: 18.5, color: rgb(.95, .95, .95), borderColor: rgb(.3, .3, .3), borderWidth: .4 });
  page.drawRectangle({ x: 72.25, y: 430.25, width: 90, height: 20, color: rgb(.2, .4, .6) });
  page.drawLine({ start: { x: 72.25, y: 410.25 }, end: { x: 540.25, y: 410.25 }, thickness: .5, color: rgb(.999, .999, .999) });
  source = await pdf.save();
  original = await withPdfDocument(new Blob([source]), doc => renderPdfPage(doc, 1, 2, { reference: true }));
  const sealed = await createQRedSeals({ ...keys, timestamp: "2026-11-04T07:00:00Z", content: "Invoice 1042\nAmount 50.00", pageContext: { pageNumber: 1, pageCount: 1 } });
  record = qrPayloadBytes(sealed.seals[0]);
  plan = await planNonoverlapErasure(original, record);
}, 30000);
async function stamped(omit = []) {
  const pdf = await PDFDocument.load(source);
  if (!omit.length) drawNonoverlapErasurePlan(pdf.getPage(0), plan);
  else plan.symbols.forEach((symbol, i) => { if (!omit.includes(i)) drawQrSymbol(pdf.getPage(0), symbol, plan.boxes[i], .85, false); });
  return pdf.save();
}
it("plans separate pale symbols without resizing or touching any nonwhite source pixel", async () => {
  expect(plan.status).toBe("available"); expect(plan.boxes).toHaveLength(16);
  const image = await withPdfDocument(new Blob([await stamped()]), doc => renderPdfPage(doc, 1, 2, { reference: true }));
  expect([image.width, image.height]).toEqual([original.width, original.height]);
  let originalInk = 0;
  for (let i = 0; i < original.data.length; i += 4) if (original.data[i] !== 255 || original.data[i + 1] !== 255 || original.data[i + 2] !== 255 || original.data[i + 3] !== 255) {
    expect(image.data.slice(i, i + 4)).toEqual(original.data.slice(i, i + 4)); originalInk++;
  }
  expect(originalInk).toBeGreaterThan(1000);
  expect(Array.from(original.data).some(value => value > 0 && value < 255)).toBe(true);
  // Full quiet-zone boxes really do touch in this optical recovery fixture.
  expect(plan.boxes.some((b, i) => plan.boxes.slice(0, i).some(a =>
    (Math.abs(b.x - a.x) === b.width && Math.abs(b.y - a.y) < b.height) ||
    (Math.abs(b.y - a.y) === b.height && Math.abs(b.x - a.x) < b.width)))).toBe(true);
  const seals = await scanErasureSeals(image);
  expect(seals).toHaveLength(16);
  expect(await verifySealCollection(seals, keys.publicKey)).toMatchObject([{ status: "VALID", content: "Invoice 1042\nAmount 50.00" }]);
}, 30000);
it("normal PDF scanning authenticates with four entire symbols absent", async () => {
  const values = [], blob = new Blob([await stamped([0, 5, 10, 15])]);
  const scanned = await scanPdfSeals(blob, { onSeal: value => values.push(value) });
  expect(scanned).toMatchObject({ pageCount: 1, pagesWithSeals: 1, sealCount: 12, missingPages: [], failedPages: [] });
  expect(await verifySealCollection(values, keys.publicKey)).toMatchObject([{ status: "VALID", page_number: 1 }]);
}, 30000);
it.each([2, 8 / 3])("captured-photo decoding recovers twelve shards at render scale %s without changing its evidence", async scale => {
  const rendered = await withPdfDocument(new Blob([await stamped([0, 5, 10, 15])]), doc => renderPdfPage(doc, 1, scale, { reference: true }));
  // A camera supplies pixels only, never PDF geometry or known QR locations.
  const photo = { width: rendered.width, height: rendered.height, data: rendered.data };
  const before = await crypto.subtle.digest("SHA-256", photo.data);
  const action = await decodePhotoWithErasure(photo, { returnPayload: true });
  expect(action.status).toBe("found-multiple"); expect(action.texts).toHaveLength(12);
  expect(await recoverErasureRecord(action.texts.map(qrPayloadBytes))).toEqual(record);
  expect(await verifySealCollection(action.texts, keys.publicKey)).toMatchObject([{ status: "VALID", content: "Invoice 1042\nAmount 50.00" }]);
  expect(new Uint8Array(await crypto.subtle.digest("SHA-256", photo.data))).toEqual(new Uint8Array(before));
  // Seal authentication is separate from the OCR comparison of this photo.
  expect(action).not.toHaveProperty("ocr"); expect(action).not.toHaveProperty("signature_valid");
}, 30000);
it("returns explicit fallback reasons rather than shrinking text, modules, or evidence", async () => {
  const data = new Uint8ClampedArray(original.data.length).fill(254);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  expect(await planNonoverlapErasure({ ...original, data }, record)).toEqual({ status: "unavailable", reason: "insufficient-whitespace" });
  expect(await planNonoverlapErasure({ ...original, scale: 3 }, record)).toEqual({ status: "unavailable", reason: "unsupported-render" });
  expect(await planNonoverlapErasure(original, new Uint8Array(50000))).toEqual({ status: "unavailable", reason: "transport-capacity" });
  for (const options of [{ moduleSize: .5 }, { moduleSize: NaN }, { margin: 18 }, { margin: 35.99 }, { margin: Infinity }, { guard: 1.99 }, { guard: NaN }])
    expect(await planNonoverlapErasure(original, record, options)).toEqual({ status: "unavailable", reason: "invalid-placement-policy" });
});
it("bounds candidate discovery and honors cancellation before decoding", async () => {
  expect(erasureCandidates({ width: 3000, height: 3000, data: [] })).toEqual([]);
  const controller = new AbortController(); controller.abort();
  await expect(scanErasureSeals(original, { signal: controller.signal })).rejects.toThrow();
});

it.each([{ rotation: 90 }, { userUnit: 2 }, { bounds: { x: 10, y: 0, width: 612, height: 792 } },
  { rotation: undefined }, { bounds: { x: 0, y: 0, width: 600, height: 792 } }])(
  "rejects unsupported render geometry before planning %j", async geometry => {
    expect(await planNonoverlapErasure({ ...original, ...geometry }, record)).toEqual({ status: "unavailable", reason: "unsupported-render" });
  });

it("uses bounded alternate traversals when forward row-major would miss a symbol", async () => {
  const side = Math.round(plan.boxes[0].width * 2), padding = 4, data = new Uint8ClampedArray(original.data.length);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const white = (x, y, w, h) => { for (let row = y; row < y + h; row++) data.fill(255, (row * original.width + x) * 4, (row * original.width + x + w) * 4); };
  const left = 72, top = 72, room = side + 2 * padding, bump = Math.floor(side / 2);
  // A one-pixel earlier center origin blocks both bottom origins for forward
  // row-major. Reverse/column traversals can place two full quiet-zone boxes.
  white(left, top + 1, 2 * side + 2 * padding, room);
  white(left + bump, top, room, 1);
  const origins = [{ x: left + bump + padding, y: top + padding }];
  for (let x = left + padding; x <= left + padding + side; x++) origins.push({ x, y: top + padding + 1 });
  for (let i = 0; i < 14; i++) {
    const x = 72 + (i % 7) * (room + 16), y = 72 + 2 * room + Math.floor(i / 7) * (room + 16);
    white(x, y, room, room); origins.push({ x: x + padding, y: y + padding });
  }
  const forward = [];
  for (const p of origins.sort((a, b) => a.y - b.y || a.x - b.x))
    if (!forward.some(q => Math.abs(p.x - q.x) < side && Math.abs(p.y - q.y) < side)) forward.push(p);
  expect(forward).toHaveLength(15);
  const input = { ...original, data }, first = await planNonoverlapErasure(input, record), second = await planNonoverlapErasure(input, record);
  expect(first.status).toBe("available"); expect(first.boxes).toHaveLength(16);
  expect(first.boxes).toEqual(second.boxes); expect(first.placementStrategy).toBe(second.placementStrategy);
  expect(first.shards).toEqual(plan.shards);
  for (let i = 0; i < first.boxes.length; i++) {
    const box = first.boxes[i];
    expect(box.pixelX - padding).toBeGreaterThanOrEqual(72); expect(box.pixelY - padding).toBeGreaterThanOrEqual(72);
    expect(box.pixelX + side + padding).toBeLessThanOrEqual(original.width - 72);
    expect(box.pixelY + side + padding).toBeLessThanOrEqual(original.height - 72);
    for (let y = box.pixelY - padding; y < box.pixelY + side + padding; y++)
      expect(data.subarray((y * original.width + box.pixelX - padding) * 4, (y * original.width + box.pixelX + side + padding) * 4).every(value => value === 255)).toBe(true);
    for (const other of first.boxes.slice(0, i))
      expect(Math.abs(box.pixelX - other.pixelX) >= side || Math.abs(box.pixelY - other.pixelY) >= side).toBe(true);
  }
  expect(first.boxes.some((b, i) => first.boxes.slice(0, i).some(a => b.pixelY === a.pixelY && Math.abs(b.pixelX - a.pixelX) === side))).toBe(true);
}, 30000);

it.each([[254, 254, 254, 255], [255, 255, 255, 254]])("never treats faint or transparent source pixels %j as whitespace", async color => {
  const data = new Uint8ClampedArray(original.data.length);
  for (let i = 0; i < data.length; i += 4) data.set(color, i);
  expect(await planNonoverlapErasure({ ...original, data }, record)).toEqual({ status: "unavailable", reason: "insufficient-whitespace" });
});

it("rejects oversized inputs and drawing without a matching available plan", async () => {
  expect(await planNonoverlapErasure({ ...original, width: 2000, height: 2000, bounds: { x: 0, y: 0, width: 1000, height: 1000 }, data: { length: 16_000_000 } }, record))
    .toEqual({ status: "unavailable", reason: "unsupported-render" });
  const pdf = await PDFDocument.create(), page = pdf.addPage([612, 792]);
  expect(() => drawNonoverlapErasurePlan(page, { status: "unavailable" })).toThrow(/matching available/);
  expect(() => drawNonoverlapErasurePlan(pdf.addPage([300, 400]), plan)).toThrow(/matching available/);
});


it("honors planner cancellation before work and between bounded stages", async () => {
  const already = new AbortController(); already.abort();
  await expect(planNonoverlapErasure(original, record, { signal: already.signal })).rejects.toThrow();
  const controller = new AbortController(), pending = planNonoverlapErasure(original, record, { signal: controller.signal });
  setTimeout(() => controller.abort(), 0);
  await expect(pending).rejects.toThrow();
});
