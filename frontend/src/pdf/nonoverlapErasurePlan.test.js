import { beforeAll, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createQRedSeals } from "../qredSealer.js";
import { qrPayloadBytes } from "../sealFormat.js";
import { planNonoverlapErasure } from "./nonoverlapErasurePlan.js";
import { withPdfDocument, renderPdfPage } from "./readPdfText.js";
import { drawQrSymbol } from "./qrDrawing.js";
import { scanErasureSeals, erasureCandidates } from "../qr/scanErasureSeals.js";
import { verifySealCollection } from "../sealCollection.js";
import { scanPdfSeals } from "../verifier/scanPdf.js";
const keys = { privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=", publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=" };
let source, original, record, plan;
beforeAll(async () => {
  const pdf = await PDFDocument.create(), page = pdf.addPage([612, 792]), font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Invoice 1042", { x: 72, y: 700, size: 18, font });
  page.drawText("Amount 50.00", { x: 72, y: 660, size: 18, font });
  source = await pdf.save();
  original = await withPdfDocument(new Blob([source]), doc => renderPdfPage(doc, 1, 2, { reference: true }));
  const sealed = await createQRedSeals({ ...keys, timestamp: "2026-11-04T07:00:00Z", content: "Invoice 1042\nAmount 50.00", pageContext: { pageNumber: 1, pageCount: 1 } });
  record = qrPayloadBytes(sealed.seals[0]);
  plan = await planNonoverlapErasure(original, record);
}, 30000);
async function stamped(omit = []) {
  const pdf = await PDFDocument.load(source);
  plan.symbols.forEach((symbol, i) => { if (!omit.includes(i)) drawQrSymbol(pdf.getPage(0), symbol, plan.boxes[i], .85, true); });
  return pdf.save();
}
it("plans separate pale symbols without resizing or touching any nonwhite source pixel", async () => {
  expect(plan.status).toBe("available"); expect(plan.boxes).toHaveLength(16);
  const image = await withPdfDocument(new Blob([await stamped()]), doc => renderPdfPage(doc, 1, 2, { reference: true }));
  expect([image.width, image.height]).toEqual([original.width, original.height]);
  let originalInk = 0;
  for (let i = 0; i < original.data.length; i += 4) if (original.data[i] !== 255 || original.data[i + 1] !== 255 || original.data[i + 2] !== 255) {
    expect(image.data.slice(i, i + 4)).toEqual(original.data.slice(i, i + 4)); originalInk++;
  }
  expect(originalInk).toBeGreaterThan(1000);
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
it("returns explicit fallback reasons rather than shrinking text, modules, or evidence", async () => {
  const data = new Uint8ClampedArray(original.data.length).fill(254);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  expect(await planNonoverlapErasure({ ...original, data }, record)).toEqual({ status: "unavailable", reason: "insufficient-whitespace" });
  expect(await planNonoverlapErasure({ ...original, scale: 3 }, record)).toEqual({ status: "unavailable", reason: "unsupported-render" });
  expect(await planNonoverlapErasure(original, new Uint8Array(50000))).toEqual({ status: "unavailable", reason: "transport-capacity" });
  expect(await planNonoverlapErasure(original, record, { moduleSize: .5 })).toEqual({ status: "unavailable", reason: "invalid-placement-policy" });
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
