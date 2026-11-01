import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PDFDocument, rgb } from "pdf-lib";
import { sealPdfInBrowser } from "../pdfClientSeal.js";
import { scanQrImage } from "../qr/scanQrImage.js";
import { hiddenPayloadFromScanResult } from "../qr/hiddenPayload.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { renderPdfPage, withPdfDocument } from "./readPdfText.js";
import { ENTRY_URL, findEntryForWatermark, findEntryPlacement } from "./watermark.js";
import { scanPdfPage } from "../verifier/scanPdf.js";

// Exercise the real signer, renderer, QR decoder, and signed-payload preflight.
// Force the initial failure that starts each retry sequence; every successful
// candidate still passes the real decoding and signed-payload preflight.
const preflight = vi.hoisted(() => ({ forceSquare: true, failFirstEntry: true,
  failFirstAligned: false, layouts: [] }));
vi.mock("./watermark.js", async importOriginal => {
  const real = await importOriginal();
  return {
    ...real,
    planPdfWatermarks: async (file, seals, pages, options = {}) => {
      const layouts = await real.planPdfWatermarks(file, seals, pages, options);
      // Keep the original entry-removal regression on the square-layout
      // branch. A separate test below starts with the preferred rectangle.
      if (preflight.forceSquare && layouts.some(layout => layout?.pageAligned)) {
        return real.planPdfWatermarks(file, seals, pages, { ...options, excludedLayouts: layouts });
      }
      return layouts;
    },
    checkWatermarks: async (bytes, layouts, pageSeals, options) => {
      preflight.layouts.push(layouts[0]?.pageAligned ? "page-aligned" : layouts[0]?.entry ? "entry" : "no-entry");
      if (preflight.failFirstAligned && layouts[0]?.pageAligned) {
        preflight.failFirstAligned = false;
        options?.onFailure?.(0, "Simulated unreadable full-page rectangle.");
        return [0];
      }
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
  preflight.forceSquare = true;
  preflight.failFirstEntry = true;
  preflight.failFirstAligned = false;
  preflight.layouts.length = 0;
  vi.setSystemTime(new Date("2026-10-22T06:00:00Z"));
});
afterEach(() => vi.useRealTimers());

async function makeInvoice(narrowMargins = false) {
  // Synthetic invoice-like page; no real customer's document is committed.
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  // Exercise graphic avoidance on both square fallbacks and optional overlays.
  page.drawRectangle({ x: 260, y: 360, width: 125, height: 120, color: rgb(0, 0, 0) });
  page.drawText("SAMPLE INVOICE", { x: 420, y: 660, size: 11 });
  page.drawText("Example Customer", { x: narrowMargins ? 32 : 36, y: 660, size: 11 });
  page.drawText("Paid in full", { x: 36, y: 580, size: 11 });
  page.drawText("Thank you", { x: 260, y: 140, size: 10 });
  return new File([await pdf.save()], "synthetic-restore-navigation.pdf", { type: "application/pdf" });
}

it("restores a decodable navigation QR after recovering a readable signed watermark", async () => {
  const source = await makeInvoice();
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

it.each([false, true])("verifies a smaller square after the rectangle fails (narrow margins: %s)", async narrowMargins => {
  preflight.forceSquare = false;
  preflight.failFirstEntry = false;
  preflight.failFirstAligned = true;
  const result = await sealPdfInBrowser({
    file: await makeInvoice(narrowMargins), privateKey, publicKey, pageScalingStrategy: "automatic",
  });
  expect(preflight.layouts[0]).toBe("page-aligned");
  expect(preflight.layouts.slice(1)).not.toContain("page-aligned");
  expect(preflight.layouts).toContain("no-entry");
  expect(preflight.layouts.at(-1)).toBe("entry");
  expect(result.footerPages).toEqual([]);
  const layout = result.watermarkLayout[0];
  expect(layout.pageAligned).toBeUndefined();
  expect(layout.boxes[0].width).toBeCloseTo(layout.boxes[0].height);
  await withPdfDocument(result.blob, async doc => {
    const scanned = await scanPdfPage(await renderPdfPage(doc, 1));
    expect(scanned.seals).toEqual(result.pageSealStrings[0]);
    await expect(verifyQRedSeals(scanned.seals, publicKey))
      .resolves.toMatchObject({ status: "VALID", page_number: 1, page_count: 1 });
  });
}, 60000);

it("keeps legacy square quiet zones free of navigation overlays", () => {
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

it("retains the verified full-page watermark when its optional navigation overlay fails", async () => {
  preflight.forceSquare = false;
  const result = await sealPdfInBrowser({
    file: await makeInvoice(), privateKey, publicKey, pageScalingStrategy: "automatic",
  });
  expect(preflight.failFirstEntry).toBe(false);
  expect(preflight.layouts).toEqual(["page-aligned", "page-aligned"]);
  expect(result.footerPages).toEqual([]);
  expect(result.watermarkLayout[0]?.pageAligned).toBe(true);
  expect(result.watermarkLayout[0]?.entry).toBeUndefined();
  await withPdfDocument(result.blob, async doc => {
    const scanned = await scanPdfPage(await renderPdfPage(doc, 1));
    expect(scanned.seals).toEqual(result.pageSealStrings[0]);
    await expect(verifyQRedSeals(scanned.seals, publicKey)).resolves.toMatchObject({ status: "VALID" });
  });
}, 60000);
