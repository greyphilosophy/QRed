import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, degrees, rgb } from "pdf-lib";
import { PNG } from "pngjs";
import jsQR from "jsqr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractPdfText, planQrStampLayoutForFooterBand, sealPdfInBrowser } from "./pdfClientSeal.js";
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

function render(bytes, page = 1) {
  const dir = mkdtempSync(join(tmpdir(), "qred-watermark-"));
  try {
    writeFileSync(join(dir, "sealed.pdf"), Buffer.from(bytes));
    execFileSync("pdftoppm", ["-png", "-r", "144", "-f", String(page), "-singlefile", join(dir, "sealed.pdf"), join(dir, "page")]);
    return PNG.sync.read(readFileSync(join(dir, "page.png")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function crop(image, box) {
  const out = new PNG({ width: Math.ceil(box.width * 2), height: Math.ceil(box.height * 2) });
  PNG.bitblt(image, out, Math.floor(box.x * 2), Math.floor(image.height - (box.y + box.height) * 2), out.width, out.height, 0, 0);
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

  it("watermarks both invoice pages with raster logos and recovers their exact signed text", async () => {
    const file = await makeInvoice();
    const result = await sealPdfInBrowser({ file, privateKey, publicKey, pageScalingStrategy: "watermark" });
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
      // Recover from the entire Poppler-rendered page, with no placement hint.
      const payload = hiddenPayloadFromScanResult(scanQrImage(printed.data, printed.width, printed.height));
      expect(payload).toBe(result.pageSealStrings[index][0]);
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

  it("keeps two pages and black text at their original size and verifies the rendered seals", async () => {
    const file = await makeDocument({ pages: 2 });
    const original = render(await file.arrayBuffer());
    const { blob, pageSealStrings, watermarkLayout } = await sealPdfInBrowser({ file, privateKey, publicKey, pageScalingStrategy: "watermark" });
    const pdf = await PDFDocument.load(await blob.arrayBuffer());
    expect(pdf.getPages().map(page => page.getSize())).toEqual([{ width: 612, height: 792 }, { width: 612, height: 792 }]);
    expect(watermarkLayout[0].entry).toBeTruthy();
    expect(watermarkLayout[1].entry).toBeUndefined();
    expect((await extractPdfText(blob)).match(/qred\.org/g)).toHaveLength(1);
    for (let page = 1; page <= 2; page++) {
      const image = render(await blob.arrayBuffer(), page);
      const code = scanQrImage(image.data, image.width, image.height);
      const payload = hiddenPayloadFromScanResult(code);
      expect(payload).toBe(pageSealStrings[page - 1][0]);
      await expect(verifyQRedSeals([payload], publicKey)).resolves.toMatchObject({ status: "VALID", page_number: page, page_count: 2 });
      if (page === 1) {
        // Black text pixels stay at the same positions, with no scaling or whitening.
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
        // Live scanning must eventually pass the navigation code and read the watermark.
        const live = createQrFrameScanner();
        let livePayload;
        for (let frame = 0; frame < 7 && !livePayload; frame++) livePayload = hiddenPayloadFromScanResult(live(image.data, image.width, image.height));
        expect(livePayload).toBe(payload);
      }
    }
  }, 60000);

  it("keeps rotated, cropped pages intact", async () => {
    const file = await makeDocument({ rotated: true });
    const { blob } = await sealPdfInBrowser({ file, privateKey, publicKey, pageScalingStrategy: "watermark" });
    const page = (await PDFDocument.load(await blob.arrayBuffer())).getPage(0);
    expect(page.getRotation().angle).toBe(90);
    expect(page.getCropBox()).toEqual({ x: 12, y: 12, width: 588, height: 768 });
    const image = render(await blob.arrayBuffer());
    const payload = hiddenPayloadFromScanResult(scanQrImage(image.data, image.width, image.height));
    await expect(verifyQRedSeals([payload], publicKey)).resolves.toMatchObject({ status: "VALID" });
  }, 30000);

  it("fits and verifies both parts on an original A3 page", async () => {
    const file = await makeDocument({ multipart: true, size: [842, 1191] });
    const { blob, watermarkLayout, pageSealStrings } = await sealPdfInBrowser({ file, privateKey, publicKey, pageScalingStrategy: "watermark" });
    expect(pageSealStrings[0].length).toBe(2);
    const image = render(await blob.arrayBuffer());
    const payloads = watermarkLayout[0].boxes.map(box => {
      const part = crop(image, box);
      return hiddenPayloadFromScanResult(scanQrImage(part.data, part.width, part.height));
    });
    expect(payloads).toEqual(pageSealStrings[0]);
    await expect(verifyQRedSeals(payloads.reverse(), publicKey)).resolves.toMatchObject({ status: "VALID" });
  }, 30000);

  it.each([
    ["dense text", { multipart: true }],
    ["no entry-code space", { crowded: true }],
    ["an opaque graphic", { black: true }],
    ["a large embedded image on a text page", { raster: true }],
  ])("uses a readable footer for %s when a watermark cannot work", async (_label, options) => {
    const file = await makeDocument(options);
    const { blob, footerPages, pageSealStrings } = await sealPdfInBrowser({ file, privateKey, publicKey, pageScalingStrategy: "watermark" });
    expect(footerPages).toEqual([1]);
    expect((await PDFDocument.load(await blob.arrayBuffer())).getPage(0).getHeight()).toBe(1008);
    expect(pageSealStrings[0].length).toBeLessThanOrEqual(2);
    expect((await verifyQRedSeals(pageSealStrings[0], publicKey)).status).toBe("VALID");
    const printed = render(await blob.arrayBuffer());
    const layout = planQrStampLayoutForFooterBand(612, pageSealStrings[0].length);
    const scanned = pageSealStrings[0].map((_, index) => {
      // A half-page crop includes a truncated neighboring QR when there are
      // two seals. Scan each complete code and its included quiet zone instead.
      const part = crop(printed, {
        x: layout.qrOffsetX + index * (layout.qrSize + layout.gap), y: layout.qrOffsetY,
        width: layout.qrSize, height: layout.qrSize,
      });
      return hiddenPayloadFromScanResult(scanQrImage(part.data, part.width, part.height));
    });
    expect(scanned).toEqual(pageSealStrings[0]);
    await expect(verifyQRedSeals(scanned, publicKey)).resolves.toMatchObject({ status: "VALID" });
  }, 30000);

});

it("recognizes only entry links, not seal fragments or lookalike hosts", () => {
  for (const text of ["QRED.ORG", "https://qred.org/", "https://qred.org"]) expect(isQRedEntryLink(text)).toBe(true);
  for (const text of ["https://qred.org/#QRED3:abc", "https://qred.org.evil.test/", "hello qred.org"]) expect(isQRedEntryLink(text)).toBe(false);
});
