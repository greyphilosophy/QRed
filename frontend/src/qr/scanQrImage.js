import jsQR from "jsqr";
import { hiddenPayloadFromScanResult, isQRedEntryLink } from "./hiddenPayload.js";
import { filterWatermark, normalizeWatermarkLuminance } from "./watermarkFilter.js";
import { scanModuleAwareQr } from "./moduleAwareScan.js";
import { scanPageAlignedImage } from "./pageAlignedScan.js";

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

function scanAttempts(width, height, tryRescaling = true, tryWatermark = true, includeModuleAware = false) {
  const attempts = scanSizes(width, height, tryRescaling);
  if (tryWatermark) {
    const scale = Math.min(1, Math.sqrt(MAX_WATERMARK_PIXELS / (width * height)));
    const w = Math.max(1, Math.floor(width * scale)), h = Math.max(1, Math.floor(height * scale));
    const radius = Math.max(1, Math.min(4, Math.round(Math.max(w, h) / 550)));
    attempts.push([w, h, radius]);
    // In camera mode, spend only one frame on module-aware color recovery.
    // Still photos have a separately budgeted final module-aware attempt.
    if (includeModuleAware) attempts.push([w, h, radius, true]);
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

// Prepare a resolution only once. The module-aware retry consumes the exact
// same normalized ink and filtered pixels as ordinary watermark decoding.
function prepareAtSize(data, width, height, [targetWidth, targetHeight, radius]) {
  const originalSize = targetWidth === width && targetHeight === height;
  const observed = originalSize ? data : resizeRgba(data, width, height, targetWidth, targetHeight);
  if (!radius) return { observed, pixels: observed, targetWidth, targetHeight, originalSize, radius };
  const normalized = normalizeWatermarkLuminance(observed, targetWidth, targetHeight);
  const pixels = filterWatermark(observed, targetWidth, targetHeight, radius, normalized);
  return { observed, pixels, normalized, targetWidth, targetHeight, originalSize, radius };
}

function decodePrepared(prepared, width, height, moduleAware = false) {
  const { observed, pixels, normalized, targetWidth, targetHeight, originalSize, radius } = prepared;
  const code = moduleAware && radius
    ? scanModuleAwareQr(observed, pixels, targetWidth, targetHeight, normalized)
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

function scanAtSize(data, width, height, size) {
  return decodePrepared(prepareAtSize(data, width, height, size), width, height, Boolean(size[3]));
}

/** Return QR geometry in the original image's coordinates, even after a retry.
 * Hidden-payload recovery and camera overlays must use the same coordinate frame.
 */
export function scanQrImage(data, width, height, { tryRescaling = true, tryWatermark = true, maxAttempts = Infinity } = {}) {
  if (!isValidImage(data, width, height)) return null;
  let entryLink = null;
  let preparedWatermark = null;
  let attempts = 0;
  // A bounded preflight should try raw, pixel-filtered, then module-aware
  // rather than exhausting its budget on similar pixel-filter radii.
  const regularBudget = tryWatermark && Number.isFinite(maxAttempts) && maxAttempts >= 3
    ? maxAttempts - 1 : maxAttempts;
  for (const size of scanAttempts(width, height, tryRescaling, tryWatermark)) {
    if (attempts >= regularBudget) break;
    const prepared = prepareAtSize(data, width, height, size);
    if (prepared.radius && !preparedWatermark) preparedWatermark = prepared;
    const code = decodePrepared(prepared, width, height);
    attempts++;
    if (usableResult(code)) return code;
    if (code?.data) entryLink ??= code;
  }
  // Count the fallback against the same budget as ordinary scan attempts.
  // Preflight callers can reserve one attempt by setting maxAttempts = 3.
  if (preparedWatermark && attempts < maxAttempts) {
    const code = decodePrepared(preparedWatermark, width, height, true);
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
  let queued = [];
  return (data, width, height) => {
    if (!isValidImage(data, width, height)) return null;
    if (width !== previousWidth || height !== previousHeight) {
      previousWidth = width;
      previousHeight = height;
      sizes = [...scanAttempts(width, height, true, true, true), "pageAligned"];
      nextSize = 0;
      queued = [];
    }
    if (!sizes.length) return null;
    if (queued.length) return queued.shift();
    if (sizes[nextSize] === "pageAligned") {
      queued = scanPageAlignedImage({ data, width, height })
        .map(({ code }) => code).filter(usableResult);
      nextSize = queued.length ? 0 : (nextSize + 1) % sizes.length;
      return queued.shift() ?? null;
    }
    const code = scanAtSize(data, width, height, sizes[nextSize]);
    nextSize = usableResult(code) ? 0 : (nextSize + 1) % sizes.length;
    return code;
  };
}
