import { beforeEach, expect, it, vi } from "vitest";
import { PDFDocument, rgb } from "pdf-lib";
import { sealPdfInBrowser } from "../pdfClientSeal.js";
import { scanQrImage } from "../qr/scanQrImage.js";
import { hiddenPayloadFromScanResult } from "../qr/hiddenPayload.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { renderPdfPage, withPdfDocument } from "./readPdfText.js";
import { ENTRY_URL, findEntryForWatermark, findEntryPlacement } from "./watermark.js";

// Exercise the real signer, renderer, QR decoder, and signed-payload preflight.
// Only the *first* entry-bearing placement fails artificially, reproducing the
// retry sequence that used to drop the small navigation QR permanently.
const preflight = vi.hoisted(() => ({ failFirstEntry: true, layouts: [] }));
vi.mock("./watermark.js", async importOriginal => {
  const real = await importOriginal();
  return {
    ...real,
    checkWatermarks: async (bytes, layouts, pageSeals, options) => {
      preflight.layouts.push(layouts[0]?.entry ? "entry" : "no-entry");
      if (preflight.failFirstEntry && layouts[0]?.entry) {
        preflight.failFirstEntry = false;
        options?.onFailure?.(0, "Simulated failed first entry placement.");
        return [0];
      }
      return real.checkWatermarks(bytes, layouts, pageSeals, options);
    },
  };
});

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";

function crop(image, box) {
  const left = Math.floor((box.x - image.bounds.x) * image.scale);
  const top = Math.floor((image.bounds.y + image.bounds.height - box.y - box.height) * image.scale);
  const width = Math.ceil(box.width * image.scale), height = Math.ceil(box.height * image.scale);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const offset = ((top + row) * image.width + left) * 4;
    data.set(image.data.subarray(offset, offset + width * 4), row * width * 4);
  }
  return { data, width, height };
}

function intersectsWithClearance(a, b, clearance = 8) {
  return a.x < b.x + b.width + clearance && a.x + a.width > b.x - clearance &&
    a.y < b.y + b.height + clearance && a.y + a.height > b.y - clearance;
}

beforeEach(() => {
  preflight.failFirstEntry = true;
  preflight.layouts.length = 0;
  vi.setSystemTime(new Date("2026-10-22T06:00:00Z"));
});

it("restores a decodable navigation QR after recovering a readable signed watermark", async () => {
  // Synthetic invoice-like page; no real customer's document is committed.
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  // A solid logo calls for the content-avoiding square layout. Full-page
  // rectangular watermarks intentionally omit the navigation QR instead.
  page.drawRectangle({ x: 260, y: 360, width: 125, height: 120, color: rgb(0, 0, 0) });
  page.drawText("SAMPLE INVOICE", { x: 420, y: 660, size: 11 });
  page.drawText("Example Customer", { x: 36, y: 660, size: 11 });
  page.drawText("Paid in full", { x: 36, y: 580, size: 11 });
  page.drawText("Thank you", { x: 260, y: 140, size: 10 });
  const source = new File([await pdf.save()], "synthetic-restore-navigation.pdf", { type: "application/pdf" });

  const result = await sealPdfInBrowser({
    file: source, privateKey, publicKey, pageScalingStrategy: "automatic",
  });
  expect(preflight.layouts[0]).toBe("entry");
  expect(preflight.layouts).toContain("no-entry");
  expect(preflight.layouts.at(-1)).toBe("entry");
  expect(result.footerPages).toEqual([]);
  const layout = result.watermarkLayout[0];
  expect(layout.entry).toBeTruthy();
  expect(await findEntryForWatermark(source, layout.boxes)).toEqual(layout.entry);
  for (const box of layout.boxes) expect(intersectsWithClearance(layout.entry, box)).toBe(false);
  const sealedPdf = await PDFDocument.load(await result.blob.arrayBuffer());
  expect(sealedPdf.getPage(0).getSize()).toEqual({ width: 612, height: 792 });

  await withPdfDocument(result.blob, async doc => {
    const image = await renderPdfPage(doc, 1);
    const entry = crop(image, layout.entry);
    expect(scanQrImage(entry.data, entry.width, entry.height, { tryWatermark: false })?.data)
      .toBe(ENTRY_URL);
    const qr = crop(image, layout.boxes[0]);
    expect(hiddenPayloadFromScanResult(scanQrImage(qr.data, qr.width, qr.height,
      { tryRescaling: false, maxAttempts: 3 }))).toBe(result.pageSealStrings[0][0]);
  });
  await expect(verifyQRedSeals(result.pageSealStrings[0], publicKey))
    .resolves.toMatchObject({ status: "VALID", page_number: 1, page_count: 1 });
}, 60000);

it("never places the entry QR over a signed watermark or other page ink", () => {
  const width = 612, height = 792;
  const image = { width, height, scale: 1, bounds: { x: 0, y: 0, width, height },
    data: new Uint8ClampedArray(width * height * 4).fill(255) };
  // Block the bottom-right candidate with a successful watermark.
  const watermark = { x: 490, y: 14, width: 110, height: 92 };
  const candidate = findEntryPlacement(image, { avoidBoxes: [watermark] });
  expect(intersectsWithClearance(candidate, watermark)).toBe(false);
  // Entire printable area occupied: an entry QR must be omitted, not overlaid.
  expect(() => findEntryPlacement(image, { avoidBoxes: [{ x: 0, y: 0, width, height }] }))
    .toThrow(/No clear space/);
});
