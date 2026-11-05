import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import { previewForPaperEdges } from "./paperGeometryPreview.js";
import { paperColorChannel } from "./paperColor.js";

// Deliberately keep the straightforward previous implementation as an oracle.
// Edge coordinates depend on its intermediate clamped rounding, not merely
// the mathematical average. A faster implementation must preserve every byte.
function referencePreview(image) {
  const { width, height, data } = image;
  const scale = Math.sqrt(1_500_000 / (width * height));
  const w = Math.max(160, Math.floor(width * scale));
  const h = Math.max(160, Math.floor(height * scale));
  const pixels = new Uint8ClampedArray(w * h * 4);
  const offsets = [[-1, -1], [0, 0], [1, 0], [0, 1]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.round((x + 0.5) * width / w - 0.5);
    const sy = Math.round((y + 0.5) * height / h - 0.5);
    const out = (y * w + x) * 4;
    for (const [dx, dy] of offsets) {
      const px = Math.min(width - 1, Math.max(0, sx + dx));
      const py = Math.min(height - 1, Math.max(0, sy + dy));
      const input = (py * width + px) * 4;
      for (let channel = 0; channel < 3; channel++)
        pixels[out + channel] += paperColorChannel(data, input, channel, image.paperColor) / offsets.length;
    }
    pixels[out + 3] = 255;
  }
  return { data: pixels, width: w, height: h };
}

it("retains the source below the geometry cap", () => {
  const image = { data: new Uint8ClampedArray(160 * 200 * 4), width: 160, height: 200 };
  expect(previewForPaperEdges(image)).toBe(image);
});

it.each([
  { width: 1601, height: 1201 },
  { width: 1201, height: 1601, paperColor: [0.95, 1, 1.07] },
  { width: 3000, height: 4000, paperColor: [0.95, 1, 1.07] },
  { width: 160, height: 9500, paperColor: [1.2, 1, 0.85] },
])("preserves every preview byte at $width by $height", ({ width, height, paperColor }) => {
  const data = new Uint8ClampedArray(width * height * 4);
  let value = 123;
  for (let i = 0; i < data.length; i++) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    data[i] = value >>> 24;
  }
  const image = { data, width, height, paperColor };
  const expected = referencePreview(image), result = previewForPaperEdges(image);
  expect([result.width, result.height]).toEqual([expected.width, expected.height]);
  expect(Buffer.compare(Buffer.from(result.data), Buffer.from(expected.data))).toBe(0);
});
