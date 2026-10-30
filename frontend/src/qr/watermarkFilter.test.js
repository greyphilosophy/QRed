import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { filterWatermark } from "./watermarkFilter.js";

// Synthetic printed page; never store real invoices or photographed personal
// documents as public test fixtures.
function printedQr({ shadow = true, strokes = true } = {}) {
  const qr = QRCode.create("QRED.ORG", { version: 25, errorCorrectionLevel: "L" });
  const modulePixels = 8, margin = 4;
  const width = (qr.modules.size + margin * 2) * modulePixels, height = width;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const col = Math.floor(x / modulePixels) - margin;
    const row = Math.floor(y / modulePixels) - margin;
    const marked = row >= 0 && row < qr.modules.size && col >= 0 && col < qr.modules.size
      && qr.modules.get(row, col);
    const paper = shadow ? 248 - 65 * y / height : 248;
    const noise = (x * 17 + y * 31) % 7 - 3;
    const darkText = strokes && x > 65 && x < width - 65 && (
      Math.abs(y - (height * 0.29 + 3 * Math.sin(x / 40))) < 1 ||
      Math.abs(y - (height * 0.68 + 2 * Math.sin(x / 30))) < 1
    );
    const value = darkText ? 20 : Math.max(0, Math.min(255, Math.round(paper * (marked ? 0.84 : 1) + noise)));
    const offset = (y * width + x) * 4;
    data[offset] = data[offset + 1] = data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  return { data, width, height };
}

describe("watermark photo recovery", () => {
  it("decodes pale dense modules through shadows and crossing dark text", () => {
    const { data, width, height } = printedQr();
    const recovered = filterWatermark(data, width, height, 3);
    expect(jsQR(recovered, width, height, { inversionAttempts: "attemptBoth" })?.data).toBe("QRED.ORG");
  });

  it("preserves clean watermark recovery without a lighting gradient", () => {
    const { data, width, height } = printedQr({ shadow: false, strokes: false });
    const recovered = filterWatermark(data, width, height, 3);
    expect(jsQR(recovered, width, height, { inversionAttempts: "attemptBoth" })?.data).toBe("QRED.ORG");
  });

  it("does not hallucinate ink on unevenly lit blank paper", () => {
    const width = 160, height = 240;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const value = 245 - Math.round(75 * y / height);
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
    const recovered = filterWatermark(data, width, height);
    for (let i = 0; i < recovered.length; i += 4) expect(recovered[i]).toBe(255);
  });
});
