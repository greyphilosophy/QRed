import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { filterWatermark } from "./watermarkFilter.js";
import { scanModuleAwareQr } from "./moduleAwareScan.js";
import { createQRedQrSymbol } from "../qredQr.js";
import { hiddenPayloadFromScanResult } from "./hiddenPayload.js";

function photographedQr({ text = true, blank = false, symbol } = {}) {
  const qr = symbol ?? QRCode.create("QRED.ORG", { version: 10, errorCorrectionLevel: "L" });
  const tile = 10, margin = 4;
  const width = (qr.modules.size + margin * 2) * tile;
  const height = width;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const row = Math.floor(y / tile) - margin, col = Math.floor(x / tile) - margin;
    const moduleInk = !blank && row >= 0 && col >= 0 &&
      row < qr.modules.size && col < qr.modules.size && qr.modules.get(row, col);
    const paper = 248 - y / height * 35;
    const offset = (y * width + x) * 4;
    // Black text is placed through the module centers, but leaves exposed
    // areas of the pale underlying modules. Keep finder patterns untouched.
    const inFinder = row < 9 && col < 9 ||
      row < 9 && col >= qr.modules.size - 9 ||
      row >= qr.modules.size - 9 && col < 9;
    const textInk = text && !inFinder && row >= 0 && col >= 0 &&
      (x % tile === 4 || x % tile === 5) && y > 70 && y < height - 70;
    const value = textInk ? 20 : Math.round((moduleInk ? paper * 0.85 : paper) + ((x + y * 3) % 5 - 2));
    rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
  return { rgba, width, height };
}

describe("module-aware watermark recovery", () => {
  it("locates the QR grid and reads exposed portions of text-obscured modules", () => {
    const { rgba, width, height } = photographedQr();
    const filtered = filterWatermark(rgba, width, height, 3);
    const code = scanModuleAwareQr(rgba, filtered, width, height);
    expect(code?.data).toBe("QRED.ORG");
    expect(code?.moduleAware).toBe(true);
    expect(code?.location?.topLeftFinderPattern).toBeDefined();
  });

  it("preserves the complete hidden signed-seal payload, not just QRED.ORG", () => {
    const payload = "signed-page-evidence-".repeat(30);
    const symbol = createQRedQrSymbol(payload);
    const { rgba, width, height } = photographedQr({ symbol });
    const filtered = filterWatermark(rgba, width, height, 3);
    const code = scanModuleAwareQr(rgba, filtered, width, height);
    expect(code?.data).toBe("QRED.ORG");
    expect(hiddenPayloadFromScanResult(code)).toBe(payload);
  });

  it("does not fabricate a QR from shadowed blank paper", () => {
    const { rgba, width, height } = photographedQr({ text: false, blank: true });
    const filtered = filterWatermark(rgba, width, height, 3);
    expect(scanModuleAwareQr(rgba, filtered, width, height)).toBeNull();
  });

  it("rejects malformed input without scanning", () => {
    expect(scanModuleAwareQr(new Uint8ClampedArray(4), new Uint8ClampedArray(4), 100, 100)).toBeNull();
  });
});
