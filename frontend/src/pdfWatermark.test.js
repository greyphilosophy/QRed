import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, degrees, rgb } from "pdf-lib";
import { PNG } from "pngjs";
import jsQR from "jsqr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractPdfText, sealPdfInBrowser } from "./pdfClientSeal.js";
import { scanQrImage, createQrFrameScanner } from "./qr/scanQrImage.js";
import { hiddenPayloadFromScanResult, isQRedEntryLink } from "./qr/hiddenPayload.js";
import { verifyQRedSeals } from "./qredVerifier.js";
import { ENTRY_URL, ENTRY_QR_SIZE } from "./pdf/watermark.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";

beforeEach(() => vi.setSystemTime(new Date("2026-10-22T06:00:00Z")));
afterEach(() => vi.useRealTimers());

async function makeDocument({ pages = 1, crowded = false, black = false, rotated = false, multipart = false, size = [612, 792] } = {}) {
  const pdf = await PDFDocument.create();
  let seed = 1042;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let index = 0; index < pages; index++) {
    const page = pdf.addPage(size);
    // A real opaque background: drawing the watermark underneath would vanish.
    page.drawRectangle({ x: 0, y: 0, width: size[0], height: size[1], color: rgb(crowded ? 0.94 : 1, crowded ? 0.94 : 1, crowded ? 0.94 : 1) });
    if (black) page.drawRectangle({ x: 0, y: 100, width: 612, height: 600, color: rgb(0, 0, 0) });
    const lines = Array.from({ length: multipart ? 60 : 42 }, (_, i) => multipart
      ? `${i + 1}: ${Array.from({ length: 12 }, () => next().toString(16).padStart(8, "0")).join("")}`
      : `Record ${i + 1}: ${next().toString(16)}-${next().toString(16)} | Qty ${next() % 900 + 100} | Inspected and approved.`);
    lines.forEach((line, i) => page.drawText(line, { x: 54, y: size[1] - 76 - i * (multipart ? 12 : 14), size: multipart ? 8 : 11 }));
    if (rotated) { page.setRotation(degrees(90)); page.setCropBox(12, 12, 588, 768); }
  }
  return new File([await pdf.save()], "watermark-test.pdf", { type: "application/pdf" });
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
  ])("uses a readable footer for %s when a watermark cannot work", async (_label, options) => {
    const file = await makeDocument(options);
    const { blob, footerPages, pageSealStrings } = await sealPdfInBrowser({ file, privateKey, publicKey, pageScalingStrategy: "watermark" });
    expect(footerPages).toEqual([1]);
    expect((await PDFDocument.load(await blob.arrayBuffer())).getPage(0).getHeight()).toBe(1008);
    expect(pageSealStrings[0].length).toBeLessThanOrEqual(2);
    expect((await verifyQRedSeals(pageSealStrings[0], publicKey)).status).toBe("VALID");
    const printed = render(await blob.arrayBuffer());
    const part = crop(printed, { x: 0, y: 0, width: pageSealStrings[0].length === 1 ? 612 : 306, height: 216 });
    const payload = hiddenPayloadFromScanResult(scanQrImage(part.data, part.width, part.height));
    expect(pageSealStrings[0]).toContain(payload);
  }, 30000);

});

it("recognizes only entry links, not seal fragments or lookalike hosts", () => {
  for (const text of ["QRED.ORG", "https://qred.org/", "https://qred.org"]) expect(isQRedEntryLink(text)).toBe(true);
  for (const text of ["https://qred.org/#QRED3:abc", "https://qred.org.evil.test/", "hello qred.org"]) expect(isQRedEntryLink(text)).toBe(false);
});
