import { beforeEach, describe, expect, it, vi } from "vitest";
import jsQR from "jsqr";
import { scanModuleAwareQr } from "./moduleAwareScan.js";
import { scanQrImage, scanWatermarkPreview } from "./scanQrImage.js";

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
});
