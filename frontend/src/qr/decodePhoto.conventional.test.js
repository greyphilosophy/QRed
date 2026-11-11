import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { decodePhoto } from "./decodePhoto.js";
import { scanQrImage } from "./scanQrImage.js";
import { qredPayloadFromScanResult } from "./qrPayload.js";
import { verifyQRedSeals } from "../qredVerifier.js";

const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";

it("recovers the original dense footer after the cheap whole-page ordinary preview misses it", async () => {
  const image = PNG.sync.read(readFileSync("../tests/fixtures/compact-qr/invoice-full-300dpi.png"));
  image.data = new Uint8ClampedArray(image.data);
  const original = image.data.slice();
  expect(image.width * image.height).toBeGreaterThan(10_000_000);
  const preview = scanQrImage(image.data, image.width, image.height, {
    tryRescaling: false, tryWatermark: false, maxAttempts: 2,
    maxScanPixels: 1_500_000, fastResize: true,
  });
  expect(qredPayloadFromScanResult(preview)).toBeNull();
  const stages = [];
  // Browser upload tests exercise the production worker watchdog separately.
  const result = decodePhoto(image, { returnPayload: true, maxDurationMs: 30_000,
    onStage: ({ stage }) => stages.push(stage) });
  expect(stages).toContain("ordinary-qr");
  expect(stages).toContain("footer");
  const payloads = result.texts ?? (result.text ? [result.text] : []);
  expect(payloads.length).toBeGreaterThan(0);
  await expect(verifyQRedSeals(payloads, publicKey)).resolves.toMatchObject({
    status: "VALID", content: expect.stringContaining("Approved total: $123.45"),
  });
  await expect(verifyQRedSeals(payloads, "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI="))
    .resolves.toMatchObject({ status: "INVALID" });
  expect(image.data.every((value, index) => value === original[index])).toBe(true);
}, 40_000);
