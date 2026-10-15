import { readFileSync } from "node:fs";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import { scanQrImage } from "./scanQrImage.js";
import { qredPayloadFromPhotoScanResult, verifyQRedSeals, VISIBLE_QR_TEXT } from "../qredVerifier.js";

const publicKey = "Sz8MZnNyHPkt6J3hC_rcXEabv4rrQSgAH_krcitjlF8";

function fixture(name) {
  const image = PNG.sync.read(readFileSync(`../tests/fixtures/qr-scans/${name}.png`));
  return { ...image, data: new Uint8ClampedArray(image.data) };
}

function readSeal(image) {
  const code = scanQrImage(image.data, image.width, image.height);
  expect(code?.data).toBe(VISIBLE_QR_TEXT);
  return qredPayloadFromPhotoScanResult(image.data, image.width, image.height, code);
}

describe("scanning rendered production PDF seals", () => {
  it.each([
    ["invoice-footer-300dpi", "Approved total: $123.45"],
    ["invoice-full-300dpi", "Approved total: $123.45"],
    ["inventory-footer-300dpi", "Inventory dispatch QA-1042 | Page 1 of 2"],
    ["inventory-four-inch-300dpi", "Inventory dispatch QA-1042 | Page 1 of 2"],
  ])("recovers and verifies %s after the original-scale decoder fails", async (name, content) => {
    const image = fixture(name);
    expect(jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" })).toBeNull();
    const seal = readSeal(image);
    await expect(verifyQRedSeals([seal], publicKey)).resolves.toMatchObject({
      status: "VALID", issuer: "QRed Live Test Authority", content: expect.stringContaining(content),
    });
  }, 20000);

  it("retains multi-seal completeness and signature checks after rescaling", async () => {
    const first = readSeal(fixture("manifest-seal-1-300dpi"));
    await expect(verifyQRedSeals([first], publicKey)).resolves.toMatchObject({ status: "INCOMPLETE" });
    const secondImage = fixture("manifest-seal-2-300dpi");
    expect(jsQR(secondImage.data, secondImage.width, secondImage.height)).toBeNull();
    const second = readSeal(secondImage);
    await expect(verifyQRedSeals([first, second], publicKey)).resolves.toMatchObject({
      status: "VALID", content: expect.stringContaining("END OF MANIFEST - 56 synthetic line items."),
    });
    await expect(verifyQRedSeals([first, second], "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=")).resolves.toMatchObject({ status: "INVALID" });
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
