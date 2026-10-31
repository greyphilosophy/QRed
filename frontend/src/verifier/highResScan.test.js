import { describe, expect, it, vi } from "vitest";
import { scanPdfPage } from "./scanPdf.js";
import { scanQrImage } from "../qr/scanQrImage.js";
import { scanPageAlignedImage } from "../qr/pageAlignedScan.js";

vi.mock("../qr/scanQrImage.js", () => ({ scanQrImage: vi.fn(() => null) }));
vi.mock("../qr/pageAlignedScan.js", () => ({ scanPageAlignedImage: vi.fn(() => []) }));

describe("oversized photographed-page fallback", () => {
  it("never clones a full >12MP photo for the legacy region scanner", async () => {
    // One high-resolution photo is enough to reproduce the earlier memory
    // issue. Keep this mock isolated to legacy resource budgeting: the real
    // watermark/signature acceptance suite tests complete image recovery.
    const width = 4100, height = 3100;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    const blackPixel = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
    // A large obstruction remains visible after resampling, guaranteeing a
    // fallback scan instead of the all-white fast path.
    for (let y = 1100; y < 1900; y++) for (let x = 1700; x < 2500; x++) {
      const offset = (y * width + x) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = 65;
    }
    const photo = { data, width, height };
    expect(width * height).toBeGreaterThan(12_000_000);
    const result = await scanPdfPage(photo);
    expect(result).toMatchObject({ seals: [], limited: false });
    expect(scanPageAlignedImage).toHaveBeenCalledWith(photo);
    expect(scanQrImage).toHaveBeenCalled();
    const dimensions = vi.mocked(scanQrImage).mock.calls.map(([, w, h]) => w * h);
    expect(Math.max(...dimensions)).toBeLessThanOrEqual(8_000_000);
    // The user's original photo is retained unchanged for visual comparison.
    expect(data[blackPixel]).toBe(65);
    expect(data[0]).toBe(255);
  }, 30000);
});
