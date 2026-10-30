import { beforeEach, describe, expect, it, vi } from "vitest";
import jsQR from "jsqr";
import { scanModuleAwareQr } from "./moduleAwareScan.js";
import { scanQrImage } from "./scanQrImage.js";

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
