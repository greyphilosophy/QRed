import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { scanErasureSeals, erasureCandidates } from "./scanErasureSeals.js";
import { scanQrImage } from "./scanQrImage.js";
import { createQRedSeals } from "../qredSealer.js";
import { encodeErasureChunks } from "../erasureTransport.js";
import { qrPayloadBytes, qrPayloadText } from "../sealFormat.js";

vi.mock("./scanQrImage.js", () => ({ scanQrImage: vi.fn() }));
let shards;
beforeAll(async () => {
  const seal = await createQRedSeals({ privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=",
    publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=", content: "Synthetic scanner budget fixture",
    timestamp: "2026-11-04T07:00:00Z" });
  shards = (await encodeErasureChunks(qrPayloadBytes(seal.seals[0]))).map(qrPayloadText);
});
beforeEach(() => { scanQrImage.mockReset().mockReturnValue(null); });

function blank(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) }; }
function rect(image, x, y, width, height) {
  for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) {
    const at = (yy * image.width + xx) * 4;
    image.data[at] = image.data[at + 1] = image.data[at + 2] = 80;
  }
}
function squares(count) {
  const image = blank(800, 560);
  for (let index = 0; index < count; index++) rect(image, 12 + index % 10 * 80, 12 + Math.floor(index / 10) * 80, 55, 55);
  return image;
}

it("rejects candidate floods entirely before any QR decoding", async () => {
  const allowed = squares(64), flood = squares(65);
  expect(erasureCandidates(allowed)).toHaveLength(64);
  expect(erasureCandidates(flood)).toEqual([]);
  expect(await scanErasureSeals(flood)).toEqual([]);
  expect(scanQrImage).not.toHaveBeenCalled();
});

it("rejects over four megapixels of overlapping crop work before decoding", async () => {
  const image = blank(1680, 1680);
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) for (let ring = 0; ring < 4; ring++) {
    const x = col * 420 + 14 + ring * 10, y = row * 420 + 14 + ring * 10, size = 384 - ring * 20;
    rect(image, x, y, size, 1); rect(image, x, y + size - 1, size, 1);
    rect(image, x, y, 1, size); rect(image, x + size - 1, y, 1, size);
  }
  const boxes = erasureCandidates(image);
  expect(boxes).toHaveLength(64);
  expect(boxes.reduce((sum, box) => sum + box.width * box.height, 0)).toBeGreaterThan(4_000_000);
  expect(await scanErasureSeals(image)).toEqual([]);
  expect(scanQrImage).not.toHaveBeenCalled();
});

it("discards a proposal prefix if discovery expires before its complete flood check", () => {
  const image = squares(64);
  let total = 0;
  expect(erasureCandidates(image, { shouldContinue: () => { total++; return true; } })).toHaveLength(64);
  let checks = 0;
  expect(erasureCandidates(image, { shouldContinue: () => ++checks < total - 1 })).toEqual([]);
});

it("retains decoded observations at the deadline and bounds every QR crop attempt", async () => {
  let expired = false;
  scanQrImage.mockImplementation((_data, width, height, options) => {
    expect(width * height).toBeLessThan(400 * 400);
    expect(options).toMatchObject({ tryWatermark: false, tryRescaling: true, maxAttempts: 4 });
    expect(options.shouldContinue()).toBe(true);
    expired = true;
    return { data: shards[0] };
  });
  expect(await scanErasureSeals(squares(2), { shouldContinue: () => !expired })).toEqual([shards[0]]);
  expect(scanQrImage).toHaveBeenCalledTimes(1);
});

it("honors cancellation at the asynchronous yield before QR decoding", async () => {
  const controller = new AbortController();
  const pending = scanErasureSeals(squares(1), { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(scanQrImage).not.toHaveBeenCalled();
});

it("rejects oversized discovery inputs and expired budgets without scanning", async () => {
  expect(erasureCandidates({ width: 3000, height: 1001, data: { length: 3000 * 1001 * 4 } })).toEqual([]);
  expect(await scanErasureSeals(squares(1), { shouldContinue: () => false })).toEqual([]);
  expect(scanQrImage).not.toHaveBeenCalled();
});
