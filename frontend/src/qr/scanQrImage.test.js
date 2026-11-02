import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import { createQrFrameScanner, scanQrImage } from "./scanQrImage.js";
import { qredPayloadFromPhotoScanResult, verifyQRedSeals } from "../qredVerifier.js";
import { qredPayloadFromScanResult } from "./qrPayload.js";

const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";

function fixture(name) {
  const image = PNG.sync.read(readFileSync(`../tests/fixtures/compact-qr/${name}.png`));
  return { ...image, data: new Uint8ClampedArray(image.data) };
}

function readSeal(image) {
  const code = scanQrImage(image.data, image.width, image.height);
  expect(code?.binaryData?.length).toBeGreaterThan(0);
  return qredPayloadFromPhotoScanResult(image.data, image.width, image.height, code);
}

describe("scanning rendered production PDF seals", () => {
  it("reads the next dense signed chunk in one frame after learning a working scale", async () => {
    const scan = createQrFrameScanner();
    const seals = [], frames = [];
    for (const part of [1, 2]) {
      const image = fixture(`delivery-part-${part}-200dpi`);
      let seal = null, attempts = 0;
      while (!seal && attempts < 4) {
        seal = qredPayloadFromScanResult(scan(image.data, image.width, image.height));
        attempts++;
      }
      expect(seal).toBeTruthy();
      seals.push(seal);
      frames.push(attempts);
    }
    expect(seals[0]).not.toBe(seals[1]);
    await expect(verifyQRedSeals(seals, publicKey)).resolves.toMatchObject({
      status: "VALID", content: expect.stringContaining("Item 45: Received and inspected"),
    });
    // Count actual decoder frames, not wall-clock time: this is deterministic
    // across CI machines and still exercises the real raster and QR decoder.
    expect(frames).toEqual([2, 1]);
  });

  it("recovers dense v3 grids surrounded by whitespace and verifies their corrected payloads", async () => {
    const seals = [];
    for (const part of [2, 1]) {
      const image = PNG.sync.read(readFileSync(`../tests/fixtures/compact-qr/delivery-part-${part}-200dpi.png`));
      const width = 700, offset = 75;
      const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
      for (let y = 0; y < image.height; y += 1) {
        pixels.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), ((offset + y) * width + offset) * 4);
      }
      // Dense grids remain readable with extra surrounding whitespace.
      const code = scanQrImage(pixels, width, width);
      expect(code.version).toBe(38);
      expect(code.binaryData.length).toBeGreaterThan(0);
      expect(code.location.topLeftCorner.x).toBeGreaterThan(offset);
      expect(code.location.bottomRightCorner.x).toBeLessThan(offset + image.width);
      const seal = qredPayloadFromPhotoScanResult(pixels, width, width, code);
      seals.push(seal);
      const liveScan = createQrFrameScanner();
      let liveCode;
      for (let frame = 0; frame < 4 && !liveCode; frame++) liveCode = liveScan(pixels, width, width);
      expect(qredPayloadFromPhotoScanResult(pixels, width, width, liveCode)).toBe(seal);
    }
    await expect(verifyQRedSeals(seals, "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q="))
      .resolves.toMatchObject({ status: "VALID", page_number: 1, page_count: 2,
        content: expect.stringContaining("Item 45: Received and inspected") });
  });

  it.each([
    ["invoice-footer-300dpi", "Approved total: $123.45"],
    ["invoice-full-300dpi", "Approved total: $123.45"],
    ["inventory-footer-300dpi", "Inventory dispatch QA-1042 | Page 1 of 2"],
    ["inventory-four-inch-300dpi", "Inventory dispatch QA-1042 | Page 1 of 2"],
  ])("recovers and verifies %s after PDF rasterization", async (name, content) => {
    const image = fixture(name);
    const seal = readSeal(image);
    await expect(verifyQRedSeals([seal], publicKey)).resolves.toMatchObject({ status: "VALID", content: expect.stringContaining(content) });
  }, 20000);

  it("recovers distinct chunks and verifies their complete signed record", async () => {
    const first = readSeal(fixture("manifest-seal-1-300dpi"));
    const secondImage = fixture("manifest-seal-2-300dpi");
    const second = readSeal(secondImage);
    expect(first).not.toBe(second);
    await expect(verifyQRedSeals([first, second], publicKey)).resolves.toMatchObject({ status: "VALID", content: expect.stringContaining("END OF MANIFEST - 56 synthetic line items.") });
  }, 20000);

  it.each(["invoice-full-300dpi", "inventory-footer-300dpi"])("recovers %s across live frames with original-image geometry", async (name) => {
    const image = fixture(name);
    const scan = createQrFrameScanner();
    let code = scan(image.data, image.width, image.height);
    for (let retry = 0; retry < 3 && !qredPayloadFromScanResult(code); retry += 1) {
      code = scan(image.data, image.width, image.height);
    }
    expect(code?.binaryData?.length).toBeGreaterThan(0);
    const seal = qredPayloadFromPhotoScanResult(image.data, image.width, image.height, code);
    await expect(verifyQRedSeals([seal], publicKey)).resolves.toMatchObject({ status: "VALID" });
  }, 20000);

  it("preserves ordinary QR content", async () => {
    const image = PNG.sync.read(await QRCode.toBuffer("https://example.org/ordinary", { width: 240 }));
    const code = scanQrImage(image.data, image.width, image.height);
    expect(qredPayloadFromPhotoScanResult(image.data, image.width, image.height, code)).toBe("https://example.org/ordinary");
  });

  it("returns no result for blank images or invalid dimensions", () => {
    expect(scanQrImage(new Uint8ClampedArray(120 * 120 * 4).fill(255), 120, 120)).toBeNull();
    expect(scanQrImage(new Uint8ClampedArray(), 0, 0)).toBeNull();
    expect(scanQrImage(new Uint8ClampedArray(4), 20, 20)).toBeNull();
  });
});
