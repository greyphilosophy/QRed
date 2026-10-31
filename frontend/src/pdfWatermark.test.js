import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, degrees, rgb } from "pdf-lib";
import { PNG } from "pngjs";
import jsQR from "jsqr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractPdfText, planQrStampLayout, planQrStampLayoutForFooterBand, sealPdfInBrowser } from "./pdfClientSeal.js";
import { scanQrImage, createQrFrameScanner } from "./qr/scanQrImage.js";
import { hiddenPayloadFromScanResult, isQRedEntryLink } from "./qr/hiddenPayload.js";
import { verifyQRedSeals } from "./qredVerifier.js";
import { ENTRY_URL, ENTRY_QR_SIZE } from "./pdf/watermark.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";

beforeEach(() => vi.setSystemTime(new Date("2026-10-22T06:00:00Z")));
afterEach(() => vi.useRealTimers());

async function makeDocument({ pages = 1, crowded = false, black = false, raster = false, rotated = false, multipart = false, size = [612, 792] } = {}) {
  const pdf = await PDFDocument.create();
  let seed = 1042;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let index = 0; index < pages; index++) {
    const page = pdf.addPage(size);
    // A real opaque background: drawing the watermark underneath would vanish.
    page.drawRectangle({ x: 0, y: 0, width: size[0], height: size[1], color: rgb(crowded ? 0.94 : 1, crowded ? 0.94 : 1, crowded ? 0.94 : 1) });
    if (black) page.drawRectangle({ x: 0, y: 100, width: 612, height: 600, color: rgb(0, 0, 0) });
    if (raster) {
      const pixels = new PNG({ width: 10, height: 10 });
      pixels.data.fill(0);
      for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = 255;
      page.drawImage(await pdf.embedPng(PNG.sync.write(pixels)), { x: 0, y: 100, width: 612, height: 600 });
    }
    const lines = Array.from({ length: multipart ? 60 : 42 }, (_, i) => multipart
      ? `${i + 1}: ${Array.from({ length: 12 }, () => next().toString(16).padStart(8, "0")).join("")}`
      : `Record ${i + 1}: ${next().toString(16)}-${next().toString(16)} | Qty ${next() % 900 + 100} | Inspected and approved.`);
    lines.forEach((line, i) => page.drawText(line, { x: 54, y: size[1] - 76 - i * (multipart ? 12 : 14), size: multipart ? 8 : 11 }));
    if (rotated) { page.setRotation(degrees(90)); page.setCropBox(12, 12, 588, 768); }
  }
  return new File([await pdf.save()], "watermark-test.pdf", { type: "application/pdf" });
}

// Synthetic two-page invoice: a raster letterhead on each page, table rules,
// shaded headings, and a sparse continuation. No uploaded document or data.
async function makeInvoice() {
  const pdf = await PDFDocument.create();
  const pixels = new PNG({ width: 120, height: 60 });
  for (let y = 0; y < pixels.height; y++) for (let x = 0; x < pixels.width; x++) {
    const i = (y * pixels.width + x) * 4;
    pixels.data.set([50 + x, 70 + y, 90, 255], i);
  }
  const logo = await pdf.embedPng(PNG.sync.write(pixels));
  for (let index = 0; index < 2; index++) {
    const page = pdf.addPage([612, 792]);
    page.drawImage(logo, { x: 246, y: 702, width: 120, height: 60 });
    page.drawText("EXAMPLE LODGE", { x: 250, y: 690, size: 12 });
    page.drawText("Sample Guest\n123 Example Street\nExample City", { x: 32, y: 660, size: 10, lineHeight: 14 });
    page.drawText(`INVOICE\nRoom: 123\nArrival: 10-01-26\nDeparture: 10-03-26\nPage: ${index + 1} of 2`, { x: 400, y: 660, size: 10, lineHeight: 14 });
    page.drawText("Company name:\nGroup name:\nGuest name:", { x: 32, y: 530, size: 10, lineHeight: 14 });
    if (index === 0) {
      page.drawRectangle({ x: 32, y: 470, width: 548, height: 18, color: rgb(0.95, 0.95, 0.95) });
      page.drawText("Date                 Description                                          Charges           Credits", { x: 36, y: 476, size: 10 });
      for (let row = 0; row < 13; row++) {
        const y = 454 - 13 * row;
        page.drawText(`10-0${1 + row % 2}-26`, { x: 38, y, size: 10 });
        page.drawText(["Room charge", "Room occupancy tax", "State sales tax", "City sales tax"][row % 4], { x: 100, y, size: 10 });
        page.drawText(`${(row + 1) * 17}.00`, { x: 460, y, size: 10 });
      }
      for (const y of [470, 488, 274, 180]) page.drawLine({ start: { x: 32, y }, end: { x: 580, y }, thickness: 0.5 });
      page.drawText("Total charges            1547.00\nTotal credits              1547.00\nBalance                          0.00", { x: 340, y: 248, size: 10, lineHeight: 20 });
    }
    page.drawText("Payment is due upon departure. Please retain this invoice for your records.", { x: 36, y: 112, size: 9 });
    page.drawText("Example Lodge | 100 Sample Road\nReservations: 555-0100 | example.test", { x: 220, y: 74, size: 9, lineHeight: 12 });
  }
  return new File([await pdf.save()], "synthetic-invoice.pdf", { type: "application/pdf" });
}

function render(bytes, page = 1, dpi = 144) {
  const dir = mkdtempSync(join(tmpdir(), "qred-watermark-"));
  try {
    writeFileSync(join(dir, "sealed.pdf"), Buffer.from(bytes));
    execFileSync("pdftoppm", ["-png", "-r", String(dpi), "-f", String(page), "-singlefile", join(dir, "sealed.pdf"), join(dir, "page")]);
    return PNG.sync.read(readFileSync(join(dir, "page.png")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function crop(image, box, scale = 2) {
  const out = new PNG({ width: Math.ceil(box.width * scale), height: Math.ceil(box.height * scale) });
  PNG.bitblt(image, out, Math.floor(box.x * scale), Math.floor(image.height - (box.y + box.height) * scale), out.width, out.height, 0, 0);
  return out;
}

describe("experimental PDF watermarks", () => {
  it("analyzes logos at different page locations and verifies each chosen watermark", async () => {
    const positions = [
      { x: 32, y: 624, width: 120, height: 120 },
      { x: 460, y: 624, width: 120, height: 120 },
      { x: 32, y: 36, width: 120, height: 120 },
      { x: 256, y: 346, width: 100, height: 100 },
      { x: 18, y: 150, width: 140, height: 470 },
      { x: 454, y: 150, width: 140, height: 470 },
    ];
    const source = await PDFDocument.create();
    const pixels = new PNG({ width: 20, height: 20 });
    for (let i = 0; i < pixels.data.length; i += 4) pixels.data.set([60, 90, 120, 255], i);
    const logo = await source.embedPng(PNG.sync.write(pixels));
    for (let index = 0; index < positions.length; index++) {
      const page = source.addPage([612, 792]);
      page.drawText(`Example document ${index + 1}`, { x: 200, y: 760, size: 10 });
      page.drawText("Account 123456", { x: 200, y: 40, size: 10 });
      page.drawImage(logo, positions[index]);
    }
    const file = new File([await source.save()], "synthetic-logo-locations.pdf", { type: "application/pdf" });
    const result = await sealPdfInBrowser({ file, privateKey, publicKey, pageScalingStrategy: "watermark" });
    expect(result.footerPages).toEqual([]);
    expect(result.watermarkLayout.every(Boolean)).toBe(true);
    for (let index = 0; index < positions.length; index++) {
      const printed = render(await result.blob.arrayBuffer(), index + 1);
      const payload = hiddenPayloadFromScanResult(scanQrImage(printed.data, printed.width, printed.height));
      expect(payload, `Page ${index + 1} must scan without cropping`).toBe(result.pageSealStrings[index][0]);
      await expect(verifyQRedSeals([payload], publicKey)).resolves.toMatchObject({ status: "VALID", page_number: index + 1 });
      const original = render(await file.arrayBuffer(), index + 1);
      expect(crop(printed, positions[index]).data).toEqual(crop(original, positions[index]).data);
    }
  }, 120000);

  it("defaults to watermarks on both invoice pages with raster logos and recovers their exact signed text", async () => {
    const file = await makeInvoice();
    const result = await sealPdfInBrowser({ file, privateKey, publicKey });
    expect(result.footerPages).toEqual([]);
    expect(result.watermarkLayout.every(Boolean)).toBe(true);
    expect(result.pageSealStrings.map(seals => seals.length)).toEqual([1, 1]);
    const pdf = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(pdf.getPages().map(page => page.getSize())).toEqual([{ width: 612, height: 792 }, { width: 612, height: 792 }]);
    const sourceText = await extractPdfText(file);
    expect((await extractPdfText(result.blob)).replace(/\n?Verify at qred\.org/g, "")).toBe(sourceText);
    for (let index = 0; index < 2; index++) {
      const original = render(await file.arrayBuffer(), index + 1);
      const printed = render(await result.blob.arrayBuffer(), index + 1);
      // Whole-page discovery can prefer the dark navigation link over the
      // pale signed watermark. A user can instead aim the camera at a roomy
      // view of the watermark; still require independent QR localization and
      // the exact hidden signed payload (never just the visible QRED.ORG).
      let payload = hiddenPayloadFromScanResult(scanQrImage(printed.data, printed.width, printed.height));
      if (!payload && result.watermarkLayout[index]?.entry) {
        const box = result.watermarkLayout[index].boxes[0];
        const margin = Math.min(72, Math.max(18, box.width * 0.2));
        const x = Math.max(0, box.x - margin), y = Math.max(0, box.y - margin);
        const right = Math.min(612, box.x + box.width + margin);
        const top = Math.min(792, box.y + box.height + margin);
        const framed = crop(printed, { x, y, width: right - x, height: top - y });
        payload = hiddenPayloadFromScanResult(scanQrImage(framed.data, framed.width, framed.height));
      }
      expect(payload).toBe(result.pageSealStrings[index][0]);
      if (result.watermarkLayout[index]?.entry) {
        const navigation = crop(printed, result.watermarkLayout[index].entry);
        expect(jsQR(navigation.data, navigation.width, navigation.height)?.data).toBe(ENTRY_URL);
      }
      const verified = await verifyQRedSeals([payload], publicKey);
      expect(verified).toMatchObject({ status: "VALID", page_number: index + 1, page_count: 2 });
      expect(verified.content).toBe(result.pageSealResults[index].evidence.text);
      const logoBox = { x: 246, y: 702, width: 120, height: 60 };
      expect(crop(printed, logoBox).data).toEqual(crop(original, logoBox).data);
      let blackPixels = 0, changed = 0;
      for (let i = 0; i < original.data.length; i += 4) if (original.data[i] < 8) {
        blackPixels++;
        if (printed.data[i] >= 9) changed++;
      }
      expect(blackPixels).toBeGreaterThan(1000);
      expect(changed).toBe(0);
    }
  }, 60000);

  it("uses a signed first-page watermark when no navigation QR fits", async () => {
    // Thin print rules eliminate every 70x52-point blank entry box, but
    // leave QR finder patterns and the signed payload recoverable.
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    for (let y = 24; y < 780; y += 32) {
      page.drawLine({ start: { x: 0, y }, end: { x: 612, y },
        thickness: 0.35, color: rgb(0, 0, 0) });
    }
    page.drawText("Example signed report", { x: 60, y: 740, size: 12 });
    const file = new File([await pdf.save()], "ruled-document.pdf", { type: "application/pdf" });
    const result = await sealPdfInBrowser({ file, privateKey, publicKey, pageScalingStrategy: "automatic" });
    expect(result.footerPages).toEqual([]);
    expect(result.watermarkLayout[0]?.entry).toBeUndefined();
    const sealed = await PDFDocument.load(await result.blob.arrayBuffer());
    expect(sealed.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    const printed = render(await result.blob.arrayBuffer(), 1);
    const symbol = crop(printed, result.watermarkLayout[0].boxes[0]);
    const payload = hiddenPayloadFromScanResult(scanQrImage(symbol.data, symbol.width, symbol.height));
    expect(payload).toBe(result.pageSealStrings[0][0]);
    await expect(verifyQRedSeals([payload], publicKey)).resolves.toMatchObject({
      status: "VALID", page_number: 1, page_count: 1,
    });
  }, 60000);

  it("preserves black text with a recoverable watermark or a safe footer on both pages", async () => {
    const file = await makeDocument({ pages: 2 });
    const original = render(await file.arrayBuffer());
    const { blob, pageSealStrings, watermarkLayout, footerPages } = await sealPdfInBrowser({
      file, privateKey, publicKey, pageScalingStrategy: "watermark",
    });
    const pdf = await PDFDocument.load(await blob.arrayBuffer());
    expect(pdf.getPageCount()).toBe(2);
    const extracted = await extractPdfText(blob);
    expect(extracted).toContain("Record 1:");
    expect(extracted).toContain("Record 42:");
    for (let page = 1; page <= 2; page++) {
      const isFooter = footerPages.includes(page);
      const outputPage = pdf.getPage(page - 1);
      expect(outputPage.getWidth()).toBe(612);
      expect(outputPage.getHeight()).toBe(isFooter ? 1008 : 792);
      const image = render(await blob.arrayBuffer(), page, isFooter ? 300 : 144);
      let payload;
      if (isFooter) {
        expect(watermarkLayout[page - 1]).toBeNull();
        const layout = planQrStampLayoutForFooterBand(612, pageSealStrings[page - 1].length);
        const scale = 300 / 72;
        const part = crop(image, {
          x: (layout.qrOffsetX ?? 10), y: (layout.qrOffsetY ?? 10),
          width: layout.qrSize, height: layout.qrSize,
        }, scale);
        payload = hiddenPayloadFromScanResult(scanQrImage(part.data, part.width, part.height));
      } else {
        expect(watermarkLayout[page - 1]).toBeTruthy();
        payload = hiddenPayloadFromScanResult(scanQrImage(image.data, image.width, image.height));
      }
      expect(payload).toBe(pageSealStrings[page - 1][0]);
      await expect(verifyQRedSeals([payload], publicKey)).resolves.toMatchObject({ status: "VALID", page_number: page, page_count: 2 });
      if (page === 1 && !isFooter) {
        // Only the watermark mode promises identical print geometry.
        let checked = 0, changed = 0;
        for (let i = 0; i < original.data.length; i += 4) if (original.data[i] < 8) {
          if (image.data[i] >= 9) changed++;
          checked++;
        }
        expect(checked).toBeGreaterThan(10000);
        expect(changed).toBe(0);
        const entry = crop(image, watermarkLayout[0].entry);
        expect(jsQR(entry.data, entry.width, entry.height)).toMatchObject({ data: ENTRY_URL, version: 2 });
        expect(ENTRY_QR_SIZE / 72).toBe(0.5);
        const live = createQrFrameScanner();
        let livePayload;
        for (let frame = 0; frame < 7 && !livePayload; frame++) livePayload = hiddenPayloadFromScanResult(live(image.data, image.width, image.height));
        expect(livePayload).toBe(payload);
      }
    }
  }, 60000);

  it("preserves rotated PDF geometry when safe, otherwise preserves text with a footer", async () => {
    const file = await makeDocument({ rotated: true });
    const { blob, footerPages, pageSealStrings } = await sealPdfInBrowser({ file, privateKey, publicKey, pageScalingStrategy: "watermark" });
    const page = (await PDFDocument.load(await blob.arrayBuffer())).getPage(0);
    if (!footerPages.length) {
      expect(page.getRotation().angle).toBe(90);
      expect(page.getCropBox()).toEqual({ x: 12, y: 12, width: 588, height: 768 });
    } else {
      // The existing fallback flattens rotation/crop into a new visible page.
      // The original content and signed seal must remain available.
      expect(footerPages).toEqual([1]);
      expect(await extractPdfText(blob)).toContain("Record 1:");
    }
    const image = render(await blob.arrayBuffer(), 1, footerPages.length ? 300 : 144);
    const payload = hiddenPayloadFromScanResult(scanQrImage(image.data, image.width, image.height));
    expect(payload).toBe(pageSealStrings[0][0]);
    await expect(verifyQRedSeals([payload], publicKey)).resolves.toMatchObject({ status: "VALID" });
  }, 45000);

  it("fits and verifies both signed parts on an original A3 page or a safe fallback", async () => {
    const file = await makeDocument({ multipart: true, size: [842, 1191] });
    const { blob, watermarkLayout, pageSealStrings, footerPages } = await sealPdfInBrowser({
      file, privateKey, publicKey, pageScalingStrategy: "watermark",
    });
    expect(pageSealStrings[0].length).toBe(2);
    let payloads;
    if (watermarkLayout[0]) {
      const image = render(await blob.arrayBuffer());
      payloads = watermarkLayout[0].boxes.map(box => {
        const part = crop(image, box);
        return hiddenPayloadFromScanResult(scanQrImage(part.data, part.width, part.height));
      });
    } else {
      // A correctly rejected fragile watermark must still yield two signed
      // and readable QR codes on a conventional footer.
      expect(footerPages).toEqual([1]);
      const dpi = 300, scale = dpi / 72;
      const image = render(await blob.arrayBuffer(), 1, dpi);
      const layout = planQrStampLayout(842, pageSealStrings[0].length);
      payloads = pageSealStrings[0].map((_, index) => {
        const box = {
          x: 18 + (layout.qrOffsetX ?? 10) + index * (layout.qrSize + layout.gap),
          y: 18 + (layout.qrOffsetY ?? 10),
          width: layout.qrSize, height: layout.qrSize,
        };
        const part = crop(image, box, scale);
        return hiddenPayloadFromScanResult(scanQrImage(part.data, part.width, part.height));
      });
    }
    expect(payloads).toEqual(pageSealStrings[0]);
    await expect(verifyQRedSeals(payloads.reverse(), publicKey)).resolves.toMatchObject({ status: "VALID" });
  }, 60000);

  it.each([
    ["dense text", { multipart: true }],
    ["an opaque graphic", { black: true }],
    ["a large embedded image on a text page", { raster: true }],
  ])("Automatic uses a readable footer for %s when a watermark cannot work", async (_label, options) => {
    const file = await makeDocument(options);
    const { blob, footerPages, watermarkLayout, pageSealStrings } = await sealPdfInBrowser({ file, privateKey, publicKey, pageScalingStrategy: "automatic" });
    expect(footerPages).toEqual([1]);
    expect(watermarkLayout).toEqual([null]);
    const [width, height] = options.size ?? [612, 792];
    const legal = width === 612 && height === 792;
    expect((await PDFDocument.load(await blob.arrayBuffer())).getPage(0).getSize()).toEqual({ width, height: legal ? 1008 : height });
    expect([1, 4]).toContain(pageSealStrings[0].length);
    expect((await verifyQRedSeals(pageSealStrings[0], publicKey)).status).toBe("VALID");
    // The smaller shrink-footer codes need print resolution for dense payloads.
    const scale = legal ? 2 : 300 / 72;
    const printed = render(await blob.arrayBuffer(), 1, scale * 72);
    const layout = legal ? planQrStampLayoutForFooterBand(width, pageSealStrings[0].length) : planQrStampLayout(width, pageSealStrings[0].length);
    const margin = legal ? 0 : 18;
    const scanned = pageSealStrings[0].map((_, index) => {
      // A half-page crop includes a truncated neighboring QR when there are
      // two seals. Scan each complete code and its included quiet zone instead.
      const part = crop(printed, {
        x: margin + (layout.qrOffsetX ?? 10) + (index % layout.columns) * (layout.qrSize + layout.gap),
        y: margin + (layout.qrOffsetY ?? 10) +
          (layout.rows - Math.floor(index / layout.columns) - 1) * (layout.qrSize + layout.gap),
        width: layout.qrSize, height: layout.qrSize,
      }, scale);
      return hiddenPayloadFromScanResult(scanQrImage(part.data, part.width, part.height));
    });
    expect(scanned).toEqual(pageSealStrings[0]);
    await expect(verifyQRedSeals(scanned, publicKey)).resolves.toMatchObject({ status: "VALID" });
  }, 30000);

});

it.each([
  ["Letter", [612, 792]],
  ["A4", [595, 842]],
])("preserves %s with a verified watermark despite no entry-code space", async (_name, size) => {
  // A pale full-page background prevents the small all-white navigation box;
  // signed watermarks still work and preserve the original sheet dimensions.
  const file = await makeDocument({ crowded: true, size });
  const result = await sealPdfInBrowser({ file, privateKey, publicKey, pageScalingStrategy: "automatic" });
  expect(result.footerPages).toEqual([]);
  expect(result.watermarkLayout[0]?.entry).toBeUndefined();
  expect((await PDFDocument.load(await result.blob.arrayBuffer())).getPage(0).getSize())
    .toEqual({ width: size[0], height: size[1] });
  const printed = render(await result.blob.arrayBuffer());
  const seal = crop(printed, result.watermarkLayout[0].boxes[0]);
  const signed = hiddenPayloadFromScanResult(scanQrImage(seal.data, seal.width, seal.height));
  expect(signed).toBe(result.pageSealStrings[0][0]);
  await expect(verifyQRedSeals([signed], publicKey)).resolves.toMatchObject({ status: "VALID" });
}, 60000);

it("recognizes only entry links, not seal fragments or lookalike hosts", () => {
  for (const text of ["QRED.ORG", "https://qred.org/", "https://qred.org"]) expect(isQRedEntryLink(text)).toBe(true);
  for (const text of ["https://qred.org/#QRED3:abc", "https://qred.org.evil.test/", "hello qred.org"]) expect(isQRedEntryLink(text)).toBe(false);
});
