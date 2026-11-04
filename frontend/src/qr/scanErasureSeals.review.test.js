import { expect, it, vi } from "vitest";
import { erasureCandidates, scanErasureSeals } from "./scanErasureSeals.js";
import { scanQrImage } from "./scanQrImage.js";
vi.mock("./scanQrImage.js", () => ({ scanQrImage: vi.fn(() => null) }));
function squares(count) {
  const width = 820, height = 730, data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let i = 0; i < count; i++) {
    const left = 10 + (i % 9) * 90, top = 10 + Math.floor(i / 9) * 90;
    for (let y = top; y < top + 60; y++) for (let x = left; x < left + 60; x++) {
      const at = (y * width + x) * 4; data[at] = data[at + 1] = data[at + 2] = 0;
    }
  }
  return { width, height, data };
}
it("rejects a sixty-fifth candidate before invoking any QR decoder", async () => {
  expect(erasureCandidates(squares(64))).toHaveLength(64);
  const flooded = squares(65);
  expect(erasureCandidates(flooded)).toEqual([]);
  scanQrImage.mockClear(); expect(await scanErasureSeals(flooded)).toEqual([]);
  expect(scanQrImage).not.toHaveBeenCalled();
});
it("discards candidate prefixes if discovery expires while enumerating components", () => {
  const image = squares(64); let fullChecks = 0;
  expect(erasureCandidates(image, { shouldContinue: () => { fullChecks++; return true; } })).toHaveLength(64);
  let checks = 0;
  expect(erasureCandidates(image, { shouldContinue: () => ++checks < fullChecks - 3 })).toEqual([]);
  expect(checks).toBe(fullChecks - 3);
});
it("stops after a deadline reached during the first candidate decode", async () => {
  const image = squares(4); let continueScan = true;
  scanQrImage.mockClear().mockImplementationOnce((_data, _width, _height, options) => {
    expect(options.maxAttempts).toBe(4); expect(options.shouldContinue()).toBe(true);
    continueScan = false; expect(options.shouldContinue()).toBe(false); return null;
  });
  expect(await scanErasureSeals(image, { shouldContinue: () => continueScan })).toEqual([]);
  expect(scanQrImage).toHaveBeenCalledTimes(1);
});
