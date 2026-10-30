import jsQR from "jsqr";
import { hiddenPayloadFromScanResult, isQRedEntryLink } from "./hiddenPayload.js";
import { filterWatermark } from "./watermarkFilter.js";
import { scanModuleAwareQr } from "./moduleAwareScan.js";

// Keep each decode bounded, including large photo uploads. Retry only when the
// original scale fails: dense printed codes can land badly on the pixel grid.
const MAX_SCAN_PIXELS = 12_000_000;
const RETRY_SCALES = [0.9, 1.25, 1.5];
const MAX_WATERMARK_PIXELS = 2_500_000;

function resizeRgba(data, width, height, targetWidth, targetHeight) {
  const pixels = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  function samples(sourceSize, targetSize) {
    const scale = sourceSize / targetSize;
    // Widen the linear filter when reducing an image. Point sampling can
    // alias narrow printed modules even when there are enough source pixels.
    const radius = Math.max(1, scale);
    return Array.from({ length: targetSize }, (_, index) => {
      const center = (index + 0.5) * scale - 0.5;
      const weights = [];
      let sum = 0;
      for (let source = Math.max(0, Math.ceil(center - radius)); source <= Math.min(sourceSize - 1, Math.floor(center + radius)); source += 1) {
        const weight = Math.max(0, 1 - Math.abs(source - center) / radius);
        if (weight) { weights.push([source, weight]); sum += weight; }
      }
      return weights.map(([source, weight]) => [source, weight / sum]);
    });
  }
  const xSamples = samples(width, targetWidth), ySamples = samples(height, targetHeight);
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const target = (y * targetWidth + x) * 4;
      let red = 0, green = 0, blue = 0, alpha = 0;
      for (const [sy, wy] of ySamples[y]) for (const [sx, wx] of xSamples[x]) {
        const source = (sy * width + sx) * 4, weight = wx * wy;
        red += data[source] * weight; green += data[source + 1] * weight;
        blue += data[source + 2] * weight; alpha += data[source + 3] * weight;
      }
      pixels[target] = red; pixels[target + 1] = green;
      pixels[target + 2] = blue; pixels[target + 3] = alpha;
    }
  }
  return pixels;
}

function scanSizes(width, height, tryRescaling = true) {
  const baseScale = Math.min(1, Math.sqrt(MAX_SCAN_PIXELS / (width * height)));
  const scales = tryRescaling ? [1, ...RETRY_SCALES] : [1];
  const attemptedSizes = new Set();
  const sizes = [];
  for (const factor of scales) {
    const targetWidth = Math.max(1, Math.floor(width * baseScale * factor));
    const targetHeight = Math.max(1, Math.floor(height * baseScale * factor));
    if (targetWidth * targetHeight > MAX_SCAN_PIXELS) continue;
    const size = `${targetWidth}x${targetHeight}`;
    if (attemptedSizes.has(size)) continue;
    attemptedSizes.add(size);
    sizes.push([targetWidth, targetHeight]);
  }
  return sizes;
}

function isValidImage(data, width, height) {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    && data?.length === width * height * 4;
}

function scanAttempts(width, height, tryRescaling = true, tryWatermark = true) {
  const attempts = scanSizes(width, height, tryRescaling);
  if (tryWatermark) {
    const scale = Math.min(1, Math.sqrt(MAX_WATERMARK_PIXELS / (width * height)));
    const w = Math.max(1, Math.floor(width * scale)), h = Math.max(1, Math.floor(height * scale));
    const radius = Math.max(1, Math.min(4, Math.round(Math.max(w, h) / 550)));
    attempts.push([w, h, radius]);
    attempts.push([w, h, radius + 1]);
    if (radius > 1) attempts.push([w, h, radius - 1]);
    for (const factor of [0.9, 1.25]) {
      const rw = Math.max(1, Math.floor(w * factor)), rh = Math.max(1, Math.floor(h * factor));
      if (rw * rh <= MAX_WATERMARK_PIXELS) attempts.push([rw, rh, Math.max(1, Math.round(radius * factor))]);
    }
  }
  return attempts;
}

function usableResult(code) {
  return Boolean(code?.data) && (!isQRedEntryLink(code.data) || Boolean(hiddenPayloadFromScanResult(code)));
}

function scanAtSize(data, width, height, [targetWidth, targetHeight, radius], moduleAware = false) {
  const originalSize = targetWidth === width && targetHeight === height;
  const observed = originalSize ? data : resizeRgba(data, width, height, targetWidth, targetHeight);
  const pixels = radius ? filterWatermark(observed, targetWidth, targetHeight, radius) : observed;
  // Reserve costly module classification for one last still-photo retry;
  // live camera frames must remain one ordinary decode per frame.
  const code = moduleAware && radius
    ? scanModuleAwareQr(observed, pixels, targetWidth, targetHeight)
    : jsQR(pixels, targetWidth, targetHeight, { inversionAttempts: "attemptBoth" });
  if (code && radius) code.watermark = true;
  if (!code || originalSize || !code.location) return code;
  return {
    ...code,
    location: Object.fromEntries(Object.entries(code.location).map(([name, point]) => [name, {
      x: ((point.x + 0.5) * width / targetWidth) - 0.5,
      y: ((point.y + 0.5) * height / targetHeight) - 0.5,
    }])),
  };
}

/** Return QR geometry in the original image's coordinates, even after a retry.
 * Hidden-payload recovery and camera overlays must use the same coordinate frame.
 */
export function scanQrImage(data, width, height, { tryRescaling = true, tryWatermark = true, maxAttempts = Infinity } = {}) {
  if (!isValidImage(data, width, height)) return null;
  let entryLink = null;
  const sizes = scanAttempts(width, height, tryRescaling, tryWatermark);
  let attempts = 0;
  for (const size of sizes) {
    if (++attempts > maxAttempts) break;
    const code = scanAtSize(data, width, height, size);
    if (usableResult(code)) return code;
    if (code?.data) entryLink ??= code;
  }
  // A single module-aware retry after standard attempts, not one per
  // filtered resolution. This limits latency and preserves live-frame budgets.
  const firstWatermark = sizes.find(size => size[2] && size[0] * size[1] <= MAX_WATERMARK_PIXELS);
  if (tryWatermark && maxAttempts >= 2 && firstWatermark) {
    const code = scanAtSize(data, width, height, firstWatermark, true);
    if (usableResult(code)) return code;
    if (code?.data) entryLink ??= code;
  }
  return entryLink;
}

/** One decode per live frame. A miss advances the scale for the next frame,
 * letting the camera loop yield to rendering and input between retries.
 * Give each camera session its own scanner; still images use scanQrImage.
 */
export function createQrFrameScanner() {
  let previousWidth;
  let previousHeight;
  let sizes;
  let nextSize = 0;
  return (data, width, height) => {
    if (!isValidImage(data, width, height)) return null;
    if (width !== previousWidth || height !== previousHeight) {
      previousWidth = width;
      previousHeight = height;
      sizes = scanAttempts(width, height);
      nextSize = 0;
    }
    if (!sizes.length) return null;
    const code = scanAtSize(data, width, height, sizes[nextSize]);
    nextSize = usableResult(code) ? 0 : (nextSize + 1) % sizes.length;
    return code;
  };
}
