import { beforeEach, describe, expect, it, vi } from "vitest";
import jsQR from "jsqr";
import { scanModuleAwareQr } from "./moduleAwareScan.js";
import { scanQrImage, scanWatermarkPreview } from "./scanQrImage.js";
import * as watermarkFilters from "./watermarkFilter.js";

vi.mock("jsqr", () => ({ default: vi.fn(() => null) }));
vi.mock("./moduleAwareScan.js", () => ({ scanModuleAwareQr: vi.fn(() => null) }));

const width = 80, height = 80;
const pixels = new Uint8ClampedArray(width * height * 4).fill(255);

beforeEach(() => {
  vi.mocked(jsQR).mockReset();
  vi.mocked(scanModuleAwareQr).mockReset();
  vi.mocked(jsQR).mockReturnValue(null);
  vi.mocked(scanModuleAwareQr).mockReturnValue(null);
});

describe("bounded watermark scan budget", () => {
  it("stops between image attempts when its shared deadline expires", () => {
    let checks = 0;
    scanQrImage(pixels, width, height, { shouldContinue: () => checks++ < 2 });
    expect(jsQR).toHaveBeenCalledTimes(1);
    expect(scanModuleAwareQr).not.toHaveBeenCalled();
  });
  it("tries one small watermark preview and maps its geometry back to the untouched original", () => {
    const width = 2048, height = 1536;
    const original = new Uint8ClampedArray(width * height * 4).fill(255);
    jsQR.mockReturnValue({ data: "preview", location: { topLeftCorner: { x: 20, y: 30 } } });
    const found = scanWatermarkPreview(original, width, height);
    expect(jsQR).toHaveBeenCalledTimes(1);
    const [, w, h] = jsQR.mock.calls[0];
    expect(w * h).toBeLessThanOrEqual(2_500_000);
    expect(found.location.topLeftCorner).toEqual({ x: 20.5 * width / w - 0.5, y: 30.5 * height / h - 0.5 });
    expect(original).toHaveLength(width * height * 4);
    expect(original[0]).toBe(255);
    expect(scanModuleAwareQr).not.toHaveBeenCalled();
  });

  it("counts the module-aware retry inside the three-attempt preflight limit", () => {
    scanQrImage(pixels, width, height, { tryRescaling: false, maxAttempts: 3 });
    expect(jsQR).toHaveBeenCalledTimes(2);
    expect(scanModuleAwareQr).toHaveBeenCalledTimes(1);
    const [, , targetWidth, targetHeight, normalized] = vi.mocked(scanModuleAwareQr).mock.calls[0];
    expect([targetWidth, targetHeight]).toEqual([width, height]);
    expect(normalized).toBeInstanceOf(Uint8Array);
    expect(normalized).toHaveLength(width * height);
  });

  it("reuses one normalized photo for different filter radii and keeps the final retry on the deadline", () => {
    const normalize = vi.spyOn(watermarkFilters, "normalizeWatermarkLuminance");
    const shouldContinue = () => true;
    try {
      scanQrImage(pixels, width, height, { tryRescaling: false, shouldContinue });
      expect(normalize.mock.calls.filter(([, w, h]) => w === width && h === height)).toHaveLength(1);
      expect(scanModuleAwareQr.mock.calls[0][5].shouldContinue).toBe(shouldContinue);
    } finally { normalize.mockRestore(); }
  });

  it("never exceeds a one- or two-attempt budget", () => {
    scanQrImage(pixels, width, height, { tryRescaling: false, maxAttempts: 1 });
    expect(jsQR).toHaveBeenCalledTimes(1);
    expect(scanModuleAwareQr).not.toHaveBeenCalled();

    vi.mocked(jsQR).mockClear();
    scanQrImage(pixels, width, height, { tryRescaling: false, maxAttempts: 2 });
    expect(jsQR).toHaveBeenCalledTimes(2);
    expect(scanModuleAwareQr).not.toHaveBeenCalled();
  });

  it("does not repeat image preparation after a usable ordinary result", () => {
    vi.mocked(jsQR).mockReturnValueOnce({ data: "https://example.test" });
    expect(scanQrImage(pixels, width, height, { tryRescaling: false, maxAttempts: 3 })?.data)
      .toBe("https://example.test");
    expect(jsQR).toHaveBeenCalledTimes(1);
    expect(scanModuleAwareQr).not.toHaveBeenCalled();
  });

  it("skips module recovery when watermark scanning is disabled", () => {
    scanQrImage(pixels, width, height,
      { tryRescaling: false, tryWatermark: false, maxAttempts: 3 });
    expect(jsQR).toHaveBeenCalledTimes(1);
    expect(scanModuleAwareQr).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])("counts navigation masking within a %i-attempt budget", budget => {
    const entry = { data: "HTTPS://QRED.ORG", location: {
      topLeftCorner: { x: 10, y: 10 }, topRightCorner: { x: 30, y: 10 },
      bottomLeftCorner: { x: 10, y: 30 }, bottomRightCorner: { x: 30, y: 30 },
    } };
    jsQR.mockReturnValueOnce(entry);
    expect(scanQrImage(pixels, width, height, { tryRescaling: false, maxAttempts: budget })).toBe(entry);
    expect(jsQR.mock.calls.length + scanModuleAwareQr.mock.calls.length).toBe(budget);
  });

  it("keeps the final module-aware slot when the filtered attempt finds navigation", () => {
    jsQR.mockReturnValueOnce(null).mockReturnValueOnce({ data: "HTTPS://QRED.ORG", location: {
      topLeftCorner: { x: 10, y: 10 }, topRightCorner: { x: 30, y: 10 },
      bottomLeftCorner: { x: 10, y: 30 }, bottomRightCorner: { x: 30, y: 30 },
    } });
    const original = new Uint8ClampedArray(pixels.length);
    scanQrImage(original, width, height, { tryRescaling: false, maxAttempts: 3 });
    expect(jsQR).toHaveBeenCalledTimes(2);
    expect(scanModuleAwareQr).toHaveBeenCalledTimes(1);
    expect(scanModuleAwareQr.mock.calls[0][0][(20 * width + 20) * 4]).toBe(255);
    expect(original.every(value => value === 0)).toBe(true);
  });
});

it.each([false, true])("bounds both ordinary navigation attempts from a 12 MP photo and keeps original geometry (fast: %s)", fastResize => {
  const width = 3000, height = 4000;
  const original = new Uint8ClampedArray(width * height * 4).fill(80);
  const location = {
    topLeftCorner: { x: 10, y: 10 }, topRightCorner: { x: 30, y: 10 },
    bottomLeftCorner: { x: 10, y: 30 }, bottomRightCorner: { x: 30, y: 30 },
  };
  jsQR.mockReturnValueOnce({ data: "QRED.ORG", location })
    .mockReturnValueOnce({ data: "https://example.org/ordinary", location });
  const code = scanQrImage(original, width, height, { tryRescaling: false,
    tryWatermark: false, maxAttempts: 2, maxScanPixels: 1_500_000, fastResize });
  expect(jsQR).toHaveBeenCalledTimes(2);
  for (const [working, w, h] of jsQR.mock.calls) {
    expect(w * h).toBeLessThanOrEqual(1_500_000);
    expect(working).not.toBe(original);
  }
  const [masked, w, h] = jsQR.mock.calls[1];
  expect(masked[(20 * w + 20) * 4]).toBe(255);
  expect(code.location.topLeftCorner).toEqual({
    x: 10.5 * width / w - .5, y: 10.5 * height / h - .5,
  });
  expect(original.every(value => value === 80)).toBe(true);
});

it("applies the ordinary pixel cap to every retry scale without enlarging small inputs", () => {
  const data = new Uint8ClampedArray(800 * 1200 * 4);
  scanQrImage(data, 800, 1200, { tryWatermark: false, maxScanPixels: 350_000 });
  expect(jsQR.mock.calls.length).toBeGreaterThan(1);
  expect(jsQR.mock.calls.every(([, w, h]) => w * h <= 350_000)).toBe(true);
  jsQR.mockClear();
  scanQrImage(pixels, width, height, { tryRescaling: false, tryWatermark: false, maxScanPixels: 1_500_000 });
  expect(jsQR.mock.calls[0][0]).toBe(pixels);
});

it("keeps the original default resolution for full-detail callers", () => {
  const width = 3000, height = 4000, original = new Uint8ClampedArray(width * height * 4);
  jsQR.mockReturnValueOnce({ data: "ordinary" });
  scanQrImage(original, width, height);
  expect(jsQR.mock.calls[0][0]).toBe(original);
  expect(jsQR.mock.calls[0].slice(1, 3)).toEqual([width, height]);
});

it("does not enter jsQR when preparation uses the remaining allowance", () => {
  let checks = 0;
  scanQrImage(pixels, width, height, { tryWatermark: false, maxScanPixels: 1600,
    shouldContinue: () => checks++ === 0 });
  expect(checks).toBe(2);
  expect(jsQR).not.toHaveBeenCalled();
  expect(scanModuleAwareQr).not.toHaveBeenCalled();
});

it("keeps a usable result completed during the last allowed indivisible attempt", () => {
  let running = true;
  jsQR.mockImplementationOnce(() => { running = false; return { data: "ordinary" }; });
  expect(scanQrImage(pixels, width, height, { shouldContinue: () => running })).toEqual({ data: "ordinary" });
  expect(jsQR).toHaveBeenCalledTimes(1);
});

it.each([0, -1, 1.5, NaN, Infinity])("rejects an invalid ordinary pixel budget: %s", maxScanPixels => {
  expect(() => scanQrImage(pixels, width, height, { maxScanPixels })).toThrow("Invalid QR scan pixel budget");
  expect(jsQR).not.toHaveBeenCalled();
});

it("samples pixel centers only in the opt-in quick preview", () => {
  const width = 200, height = 160, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4;
    data[at] = x; data[at + 1] = y; data[at + 2] = 117; data[at + 3] = 255;
  }
  jsQR.mockReturnValueOnce({ data: "ordinary" });
  scanQrImage(data, width, height, { tryRescaling: false, tryWatermark: false,
    maxScanPixels: 8000, fastResize: true });
  const [preview, w, h] = jsQR.mock.calls[0];
  expect([w, h]).toEqual([100, 80]);
  for (const [x, y] of [[0, 0], [8, 5], [99, 79]])
    expect(Array.from(preview.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)))
      .toEqual([2 * x + 1, 2 * y + 1, 117, 255]);
});

it("does not rebuild a masked watermark after the deadline expires during navigation decoding", () => {
  const normalize = vi.spyOn(watermarkFilters, "normalizeWatermarkLuminance");
  let running = true;
  jsQR.mockReturnValueOnce(null).mockImplementationOnce(() => {
    running = false;
    return { data: "QRED.ORG", location: {
      topLeftCorner: { x: 10, y: 10 }, topRightCorner: { x: 30, y: 10 },
      bottomLeftCorner: { x: 10, y: 30 }, bottomRightCorner: { x: 30, y: 30 },
    } };
  });
  try {
    expect(scanQrImage(pixels, width, height, { tryRescaling: false, maxAttempts: 3,
      shouldContinue: () => running })?.data).toBe("QRED.ORG");
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(scanModuleAwareQr).not.toHaveBeenCalled();
  } finally { normalize.mockRestore(); }
});

it("passes the same deadline callback into the inner QR decoder", () => {
  const shouldContinue = () => true;
  scanQrImage(pixels, width, height, { tryRescaling: false, tryWatermark: false, shouldContinue });
  expect(jsQR.mock.calls[0][3].shouldContinue).toBe(shouldContinue);
});
