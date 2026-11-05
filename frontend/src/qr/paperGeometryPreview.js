const MAX_GEOMETRY_PIXELS = 1_500_000;

// Only page geometry uses this small preview. Fine watermark evidence stays
// in the original photo. Keep the established four-neighbor average exactly,
// including the Uint8ClampedArray rounding after each sample contribution.
export function previewForPaperEdges(image) {
  const { width, height, data, paperColor } = image;
  if (width * height <= MAX_GEOMETRY_PIXELS) return image;
  const scale = Math.sqrt(MAX_GEOMETRY_PIXELS / (width * height));
  const w = Math.max(160, Math.floor(width * scale));
  const h = Math.max(160, Math.floor(height * scale));
  const pixels = new Uint8ClampedArray(w * h * 4);
  // Channel correction depends only on its byte value and this photo's gain.
  // Cache the exact quarter-contribution, not the final average: each write
  // below must still perform the original intermediate clamped rounding.
  const contributions = [0, 1, 2].map(channel => Float64Array.from(
    { length: 256 }, (_, value) => (paperColor
      ? Math.min(255, Math.round(value * paperColor[channel])) : value) / 4));
  // Source columns do not change between rows. Avoid recalculating their
  // rounding/clamping and allocating iterators for every one of 1.5M pixels.
  const columns = new Int32Array(w * 3);
  for (let x = 0; x < w; x++) {
    const sx = Math.round((x + 0.5) * width / w - 0.5);
    columns[x * 3] = Math.min(width - 1, Math.max(0, sx - 1)) * 4;
    columns[x * 3 + 1] = Math.min(width - 1, Math.max(0, sx)) * 4;
    columns[x * 3 + 2] = Math.min(width - 1, Math.max(0, sx + 1)) * 4;
  }
  for (let y = 0; y < h; y++) {
    const sy = Math.round((y + 0.5) * height / h - 0.5);
    const previous = Math.min(height - 1, Math.max(0, sy - 1)) * width * 4;
    const current = Math.min(height - 1, Math.max(0, sy)) * width * 4;
    const next = Math.min(height - 1, Math.max(0, sy + 1)) * width * 4;
    for (let x = 0; x < w; x++) {
      const out = (y * w + x) * 4;
      const a = previous + columns[x * 3], b = current + columns[x * 3 + 1];
      const c = current + columns[x * 3 + 2], d = next + columns[x * 3 + 1];
      for (let channel = 0; channel < 3; channel++) {
        const values = contributions[channel];
        pixels[out + channel] = values[data[a + channel]];
        pixels[out + channel] += values[data[b + channel]];
        pixels[out + channel] += values[data[c + channel]];
        pixels[out + channel] += values[data[d + channel]];
      }
      pixels[out + 3] = 255;
    }
  }
  return { data: pixels, width: w, height: h };
}
