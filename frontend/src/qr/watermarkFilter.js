// Separate pale QR ink from white paper and dark document text. Dark pixels
// are unknown, not white: use the surrounding known pixels to bridge strokes.
// Adjust each pixel against its local paper brightness before looking for ink.
// This avoids treating shadows across a photographed sheet as QR modules.
// The high local percentile is robust to pale modules and most printed text.
function locallyNormalize(luminances, width, height) {
  const tile = Math.max(48, Math.min(128, Math.round(Math.max(width, height) / 18)));
  const columns = Math.ceil(width / tile), rows = Math.ceil(height / tile);
  const histograms = new Uint32Array(columns * rows * 256);
  for (let y = 0; y < height; y++) {
    const rowBase = Math.floor(y / tile) * columns * 256;
    for (let x = 0; x < width; x++) {
      histograms[rowBase + Math.floor(x / tile) * 256 + luminances[y * width + x]]++;
    }
  }
  const paper = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    const pixels = Math.min(tile, width - col * tile) * Math.min(tile, height - row * tile);
    const target = Math.max(1, Math.ceil(pixels * 0.08));
    const start = (row * columns + col) * 256;
    let count = 0;
    for (let value = 255; value >= 0; value--) {
      count += histograms[start + value];
      if (count >= target) { paper[row * columns + col] = Math.max(1, value); break; }
    }
  }
  const normalized = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const gy = Math.max(0, Math.min(rows - 1, (y + 0.5) / tile - 0.5));
    const top = Math.floor(gy), bottom = Math.min(rows - 1, top + 1), fy = gy - top;
    for (let x = 0; x < width; x++) {
      const gx = Math.max(0, Math.min(columns - 1, (x + 0.5) / tile - 0.5));
      const left = Math.floor(gx), right = Math.min(columns - 1, left + 1), fx = gx - left;
      const upper = paper[top * columns + left] * (1 - fx) + paper[top * columns + right] * fx;
      const lower = paper[bottom * columns + left] * (1 - fx) + paper[bottom * columns + right] * fx;
      const reference = upper * (1 - fy) + lower * fy;
      normalized[y * width + x] = Math.min(255, Math.round(luminances[y * width + x] * 255 / reference));
    }
  }
  return normalized;
}

// Integral images keep the neighborhood vote linear in the image size.
export function filterWatermark(data, width, height, radius = 3) {
  const stride = width + 1;
  const known = new Uint32Array(stride * (height + 1));
  const gray = new Uint32Array(known.length);
  const histogram = new Uint32Array(256);
  const source = new Uint8Array(width * height);
  for (let i = 0; i < source.length; i++) {
    const offset = i * 4;
    source[i] = Math.round((data[offset] + data[offset + 1] + data[offset + 2]) / 3);
  }
  const luminances = locallyNormalize(source, width, height);
  for (const value of luminances) histogram[value]++;
  let white = 255, count = 0;
  while (white > 0 && count < width * height * 0.02) count += histogram[white--];
  white++;
  const textThreshold = white * 0.7;
  const textCoreThreshold = white * 0.3;
  // Normalize against nearby paper, then look for the pale 15%-black ink.
  // A single document-wide ink histogram was easily confused by printed text
  // and the camera's exposure gradient, especially on long full-page QR codes.
  const paperThreshold = white * 0.94;
  for (let y = 0; y < height; y++) {
    let knownRow = 0, grayRow = 0;
    for (let x = 0; x < width; x++) {
      const luminance = luminances[y * width + x];
      // Treat dark text as missing QR evidence. Neighboring unmasked pixels
      // reconstruct its module values. Grow the one-pixel fringe only from its
      // black core. Growing from already antialiased edges discards nearby
      // watermark pixels, with different damage for different PDF renderers.
      let text = luminance < textThreshold;
      for (let dy = -1; dy <= 1 && !text; dy++) {
        const row = y + dy;
        if (row < 0 || row >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const column = x + dx;
          if (column >= 0 && column < width && luminances[row * width + column] < textCoreThreshold) { text = true; break; }
        }
      }
      if (!text) {
        knownRow++;
        if (luminance < paperThreshold) grayRow++;
      }
      const index = (y + 1) * stride + x + 1;
      known[index] = known[index - stride] + knownRow;
      gray[index] = gray[index - stride] + grayRow;
    }
  }
  const pixels = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    const top = Math.max(0, y - radius) * stride;
    const bottom = Math.min(height, y + radius + 1) * stride;
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - radius), right = Math.min(width, x + radius + 1);
      const total = known[bottom + right] - known[top + right] - known[bottom + left] + known[top + left];
      const dark = gray[bottom + right] - gray[top + right] - gray[bottom + left] + gray[top + left];
      const value = dark > total / 2 ? 0 : 255;
      const i = (y * width + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = value;
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}
