// Estimate the illumination tint from the same central paper area used by
// page detection. Apply it only while reading pixels; never clone a phone's
// full-resolution raster or change the document's printed colors.
const IDENTITY = Object.freeze([1, 1, 1]);

export function estimatePaperColor({ data, width, height }) {
  const red = [], blue = [];
  for (const v of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    for (const u of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      const offset = (Math.round(v * (height - 1)) * width + Math.round(u * (width - 1))) * 4;
      const r = data[offset], g = data[offset + 1], b = data[offset + 2];
      // Dark text and clipped highlights cannot identify the paper's tint.
      if (Math.min(r, g, b) <= 100 || Math.max(r, g, b) >= 254) continue;
      red.push(g / r); blue.push(g / b);
    }
  }
  if (red.length < 9) return IDENTITY;
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const r = median(red), b = median(blue);
  // Only modest, consistent camera casts are plausible. Do not normalize a
  // saturated colored graphic into paper or infer a tint from scattered ink.
  if (r < 0.8 || r > 1.25 || b < 0.8 || b > 1.25 ||
      red.filter(value => Math.abs(value - r) < 0.04).length < red.length * 0.6 ||
      blue.filter(value => Math.abs(value - b) < 0.04).length < blue.length * 0.6) return IDENTITY;
  return [r, 1, b];
}

export function paperColorChannel(data, offset, channel, gains) {
  return gains ? Math.min(255, Math.round(data[offset + channel] * gains[channel]))
    : data[offset + channel];
}

export function photoLuminance(image, offset) {
  if (!image.paperColor) return (image.data[offset] + image.data[offset + 1] + image.data[offset + 2]) / 3;
  return (paperColorChannel(image.data, offset, 0, image.paperColor) +
    paperColorChannel(image.data, offset, 1, image.paperColor) +
    paperColorChannel(image.data, offset, 2, image.paperColor)) / 3;
}
