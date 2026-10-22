// Separate pale QR ink from white paper and dark document text. Dark pixels
// are unknown, not white: use the surrounding known pixels to bridge strokes.
// Integral images keep the neighborhood vote linear in the image size.
export function filterWatermark(data, width, height, radius = 3) {
  const stride = width + 1;
  const known = new Uint32Array(stride * (height + 1));
  const gray = new Uint32Array(known.length);
  const histogram = new Uint32Array(256);
  const luminances = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i += 4) {
    const value = Math.round((data[i] + data[i + 1] + data[i + 2]) / 3);
    luminances[i / 4] = value;
    histogram[value]++;
  }
  let white = 255, count = 0;
  while (white > 0 && count < width * height * 0.02) count += histogram[white--];
  white++;
  const textThreshold = white * 0.7;
  let ink = Math.round(white * 0.88);
  for (let value = Math.ceil(white * 0.75); value < white * 0.965; value++) {
    if (histogram[value] > histogram[ink]) ink = value;
  }
  // Put the QR threshold halfway between its gray ink and the paper. A cutoff
  // too close to white enlarges antialiased modules and corrupts finder ratios.
  const paperThreshold = (white + ink) / 2;
  for (let y = 0; y < height; y++) {
    let knownRow = 0, grayRow = 0;
    for (let x = 0; x < width; x++) {
      const luminance = luminances[y * width + x];
      // Include the antialiased fringe around a black stroke in its mask.
      // Otherwise gray letter edges become spurious QR ink on white modules.
      let text = false;
      for (let dy = -1; dy <= 1 && !text; dy++) {
        const row = y + dy;
        if (row < 0 || row >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const column = x + dx;
          if (column >= 0 && column < width && luminances[row * width + column] < textThreshold) { text = true; break; }
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
