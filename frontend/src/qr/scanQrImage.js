import jsQR from "jsqr";

// Keep each decode bounded, including large photo uploads. Retry only when the
// original scale fails: dense printed codes can land badly on the pixel grid.
const MAX_SCAN_PIXELS = 12_000_000;
const RETRY_SCALES = [0.9, 1.25, 1.5];

function resizeRgba(data, width, height, targetWidth, targetHeight) {
  const pixels = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  const xSamples = Array.from({ length: targetWidth }, (_, x) => {
    const sourceX = Math.max(0, ((x + 0.5) * width / targetWidth) - 0.5);
    const left = Math.floor(sourceX);
    return { left, right: Math.min(width - 1, left + 1), weight: sourceX - left };
  });
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.max(0, ((y + 0.5) * height / targetHeight) - 0.5);
    const top = Math.floor(sourceY);
    const bottom = Math.min(height - 1, top + 1);
    const weightY = sourceY - top;
    for (let x = 0; x < targetWidth; x += 1) {
      const { left, right, weight } = xSamples[x];
      const target = ((y * targetWidth) + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const upper = (data[((top * width) + left) * 4 + channel] * (1 - weight))
          + (data[((top * width) + right) * 4 + channel] * weight);
        const lower = (data[((bottom * width) + left) * 4 + channel] * (1 - weight))
          + (data[((bottom * width) + right) * 4 + channel] * weight);
        pixels[target + channel] = (upper * (1 - weightY)) + (lower * weightY);
      }
    }
  }
  return pixels;
}

/** Return QR geometry in the original image's coordinates, even after a retry.
 * Hidden-payload recovery and camera overlays must use the same coordinate frame.
 */
export function scanQrImage(data, width, height, { tryRescaling = true } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || !data || data.length !== width * height * 4) return null;

  const baseScale = Math.min(1, Math.sqrt(MAX_SCAN_PIXELS / (width * height)));
  const scales = tryRescaling ? [1, ...RETRY_SCALES] : [1];
  const attemptedSizes = new Set();
  for (const factor of scales) {
    const targetWidth = Math.max(1, Math.floor(width * baseScale * factor));
    const targetHeight = Math.max(1, Math.floor(height * baseScale * factor));
    if (targetWidth * targetHeight > MAX_SCAN_PIXELS) continue;
    const size = `${targetWidth}x${targetHeight}`;
    if (attemptedSizes.has(size)) continue;
    attemptedSizes.add(size);

    const originalSize = targetWidth === width && targetHeight === height;
    const pixels = originalSize ? data : resizeRgba(data, width, height, targetWidth, targetHeight);
    const code = jsQR(pixels, targetWidth, targetHeight, { inversionAttempts: "attemptBoth" });
    if (!code) continue;
    if (originalSize || !code.location) return code;
    return {
      ...code,
      location: Object.fromEntries(Object.entries(code.location).map(([name, point]) => [name, {
        x: ((point.x + 0.5) * width / targetWidth) - 0.5,
        y: ((point.y + 0.5) * height / targetHeight) - 0.5,
      }])),
    };
  }
  return null;
}
