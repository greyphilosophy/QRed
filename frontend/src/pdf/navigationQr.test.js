import { describe, expect, it } from "vitest";
import ECLevel from "qrcode/lib/core/error-correction-level";
import Mode from "qrcode/lib/core/mode";
import jsQR from "jsqr";
import { ENTRY_QR_SIZE, ENTRY_URL, createEntryQrSymbol } from "./watermark.js";
import { isQRedEntryLink } from "../qr/hiddenPayload.js";

// Draw the vector modules onto a fixed-size raster with a four-module quiet
// zone. No uploaded or private PDF data is used in these QR regressions.
function rasterizeNavigation(qr, resolution) {
  const pixels = new Uint8ClampedArray(resolution * resolution * 4).fill(255);
  const size = qr.modules.size + 8;
  for (let y = 0; y < resolution; y++) for (let x = 0; x < resolution; x++) {
    const column = Math.floor((x + 0.5) * size / resolution) - 4;
    const row = Math.floor((y + 0.5) * size / resolution) - 4;
    if (column < 0 || column >= qr.modules.size || row < 0 || row >= qr.modules.size) continue;
    if (!qr.modules.get(row, column)) continue;
    const offset = (y * resolution + x) * 4;
    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
  }
  return pixels;
}

describe("half-inch QRed navigation QR", () => {
  it("uses the 16-character URL in version 1 alphanumeric mode with Q correction", () => {
    expect(ENTRY_URL).toBe("HTTPS://QRED.ORG");
    expect(new URL(ENTRY_URL).href).toBe("https://qred.org/");
    expect(isQRedEntryLink(ENTRY_URL)).toBe(true);
    const qr = createEntryQrSymbol();
    expect(qr.version).toBe(1);
    expect(qr.modules.size).toBe(21);
    expect(qr.errorCorrectionLevel).toEqual(ECLevel.Q);
    expect(qr.segments).toHaveLength(1);
    expect(qr.segments[0].mode).toEqual(Mode.ALPHANUMERIC);
    expect(qr.segments[0].data).toBe(ENTRY_URL);
    expect(ENTRY_QR_SIZE).toBe(36);
  });

  it.each([150, 300])("decodes a simulated %i-dpi half-inch navigation QR", dpi => {
    const qr = createEntryQrSymbol();
    const size = Math.round(ENTRY_QR_SIZE * dpi / 72);
    const decoded = jsQR(rasterizeNavigation(qr, size), size, size);
    expect(decoded).toMatchObject({ data: ENTRY_URL, version: 1 });
  });
});
