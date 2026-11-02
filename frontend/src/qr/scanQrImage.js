import jsQR from "jsqr";
import { maskQrCode } from "./maskQrCode.js";
import { qredPayloadFromScanResult, isQRedEntryLink } from "./qrPayload.js";
import { filterWatermark, normalizeWatermarkLuminance } from "./watermarkFilter.js";
import { scanModuleAwareQr } from "./moduleAwareScan.js";
import { scanPageAlignedImage } from "./pageAlignedScan.js";

// Keep each decode bounded, including large photo uploads. Retry only when the
// original scale fails: dense printed codes can land badly on the pixel grid.
const MAX_SCAN_PIXELS = 12_000_000;
const RETRY_SCALES = [0.9, 1.25, 1.5];
const MAX_WATERMARK_PIXELS = 2_500_000;
const RECENT_FRAME_PAYLOAD_LIMIT = 32;

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
      // Indexed access avoids allocating iterators for every output pixel.
      // Keep the same sample order and arithmetic as the original filter.
      for (let yi = 0; yi < ySamples[y].length; yi++) for (let xi = 0; xi < xSamples[x].length; xi++) {
        const sy = ySamples[y][yi][0], wy = ySamples[y][yi][1], sx = xSamples[x][xi][0], wx = xSamples[x][xi][1];
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

function watermarkScanSize(width, height, maxPixels = MAX_WATERMARK_PIXELS) {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  const w = Math.max(1, Math.floor(width * scale)), h = Math.max(1, Math.floor(height * scale));
  return [w, h, Math.max(1, Math.min(4, Math.round(Math.max(w, h) / 550)))];
}

function scanAttempts(width, height, tryRescaling = true, tryWatermark = true, includeModuleAware = false) {
  const attempts = scanSizes(width, height, tryRescaling);
  if (tryWatermark) {
    const [w, h, radius] = watermarkScanSize(width, height);
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

function locatedEntry(code) {
  return isQRedEntryLink(code?.data) &&
    ["topLeftCorner", "topRightCorner", "bottomLeftCorner", "bottomRightCorner"]
      .every(name => Number.isFinite(code.location?.[name]?.x) && Number.isFinite(code.location?.[name]?.y));
}

function usableResult(code) {
  return Boolean(qredPayloadFromScanResult(code)) || (Boolean(code?.data) && !isQRedEntryLink(code.data));
}

// Prepare a resolution only once. The module-aware retry consumes the exact
// same normalized ink and filtered pixels as ordinary watermark decoding.
function prepareAtSize(data, width, height, [targetWidth, targetHeight, radius], entryToSkip = null) {
  const originalSize = targetWidth === width && targetHeight === height;
  let observed = originalSize ? data : resizeRgba(data, width, height, targetWidth, targetHeight);
  if (entryToSkip) {
    // Navigation is not evidence. Erase it only in this bounded working copy;
    // recovery, overlays and verification still use the original photograph.
    if (originalSize) observed = new Uint8ClampedArray(observed);
    const location = Object.fromEntries(Object.entries(entryToSkip.location).map(([name, point]) => [name, {
      x: ((point.x + 0.5) * targetWidth / width) - 0.5,
      y: ((point.y + 0.5) * targetHeight / height) - 0.5,
    }]));
    maskQrCode(observed, targetWidth, targetHeight, { location });
  }
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

function scanAtSize(data, width, height, size, entryToSkip = null) {
  return decodePrepared(prepareAtSize(data, width, height, size, entryToSkip), width, height, Boolean(size[3]));
}

// Try the established 2.5 MP watermark filter once before exhaustive photo
// alignment. Keep the original pixels for all later recovery and saved photos.
export function scanWatermarkPreview(data, width, height) {
  if (!isValidImage(data, width, height)) return null;
  return scanAtSize(data, width, height, watermarkScanSize(width, height));
}

/** Return QR geometry in the original image's coordinates, even after a retry.
 * QR recovery and camera overlays must use the same coordinate frame.
 */
export function scanQrImage(data, width, height, { tryRescaling = true, tryWatermark = true, maxAttempts = Infinity } = {}) {
  if (!isValidImage(data, width, height)) return null;
  let entryLink = null;
  let entryToSkip = null;
  let preparedWatermark = null;
  let attempts = 0;
  // A bounded preflight should try raw, pixel-filtered, then module-aware
  // rather than exhausting its budget on similar pixel-filter radii.
  const regularBudget = tryWatermark && Number.isFinite(maxAttempts) && maxAttempts >= 3
    ? maxAttempts - 1 : maxAttempts;
  const sizes = scanAttempts(width, height, tryRescaling, tryWatermark);
  for (let index = 0; index < sizes.length; index++) {
    const size = sizes[index];
    if (attempts >= regularBudget) break;
    const prepared = prepareAtSize(data, width, height, size, entryToSkip);
    if (prepared.radius && !preparedWatermark) preparedWatermark = prepared;
    const code = decodePrepared(prepared, width, height);
    attempts++;
    if (usableResult(code)) return code;
    if (code?.data) entryLink ??= code;
    if (!entryToSkip && locatedEntry(code)) {
      entryToSkip = code;
      preparedWatermark = prepared.radius && Number.isFinite(maxAttempts)
        ? prepareAtSize(data, width, height, size, entryToSkip) : null;
      // Retry this scale once for ordinary footer seals. A bounded watermark
      // preflight keeps its filtered/module-aware slots, with the link masked.
      if (!tryWatermark || !Number.isFinite(maxAttempts)) sizes.splice(index + 1, 0, size);
    }
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

/** One scan attempt per live frame. Prefer the strategy that found a new QRed
 * payload; misses and repeated payloads advance through the remaining strategies,
 * letting the camera loop yield to rendering and input between retries.
 * A page-aligned attempt returns all codes together in { codes }, so callers
 * can collect them before the originating camera frame is overwritten.
 * Give each camera session its own scanner; still images use scanQrImage.
 */
export function createQrFrameScanner({ preferWatermark = false } = {}) {
  let previousWidth;
  let previousHeight;
  let sizes;
  let nextSize = 0;
  let entryToSkip = null;
  const recentPayloads = new Set();
  function scheduleNext(codes) {
    const payloads = codes.map(qredPayloadFromScanResult).filter(Boolean);
    if (payloads.some(payload => !recentPayloads.has(payload))) {
      // Remember the strategy, never old pixels, geometry or returned codes.
      // A recognized transport is a hint; the verifier still checks its trust.
      const [successful] = sizes.splice(nextSize, 1);
      sizes.unshift(successful);
      nextSize = 0;
    } else {
      // Repeated chunks must not keep other scales or full-page recovery
      // waiting indefinitely. A miss also resumes the remaining fallbacks.
      nextSize = (nextSize + 1) % sizes.length;
    }
    // Different strategies may repeatedly find different chunks of one page.
    // Remember a bounded set so those strategies cannot keep promoting each
    // other and prevent the rest of the page from being recovered.
    for (const payload of payloads) {
      recentPayloads.delete(payload);
      recentPayloads.add(payload);
      if (recentPayloads.size > RECENT_FRAME_PAYLOAD_LIMIT)
        recentPayloads.delete(recentPayloads.values().next().value);
    }
  }
  return (data, width, height) => {
    if (!isValidImage(data, width, height)) return null;
    if (width !== previousWidth || height !== previousHeight) {
      previousWidth = width;
      previousHeight = height;
      sizes = [...scanAttempts(width, height, true, true, true), "pageAligned"];
      // Whole-page verification normally sees a pale watermark. Try its one
      // bounded preview before expensive ordinary-code rescaling; keep every
      // fallback, and let a successful footer strategy become preferred too.
      if (preferWatermark) {
        sizes.unshift(...sizes.splice(sizes.findIndex(size => size[2]), 1));
        const preview = watermarkScanSize(width, height, 1_000_000);
        // Most clearly framed pages have ample module detail at this scale.
        // Dense or awkwardly sampled seals retain the established 2.5 MP pass
        // immediately afterward, and all original-resolution fallbacks.
        if (preview[0] !== sizes[0][0] || preview[1] !== sizes[0][1]) sizes.unshift(preview);
      }
      nextSize = 0;
      entryToSkip = null;
      recentPayloads.clear();
    }
    if (!sizes.length) return null;
    if (sizes[nextSize] === "pageAligned") {
      // Keep exhaustive refinement in the selected/captured-photo worker.
      // Live scanning should try again with the operator's latest framing.
      const codes = scanPageAlignedImage({ data, width, height }, { deep: false })
        .map(({ code }) => code).filter(usableResult);
      scheduleNext(codes);
      return codes.length ? { codes } : null;
    }
    const skippingEntry = entryToSkip;
    const code = scanAtSize(data, width, height, sizes[nextSize], skippingEntry);
    entryToSkip = null;
    if (!skippingEntry && locatedEntry(code)) {
      // One decode per frame: use the next fresh frame for a single masked
      // retry. Discard the old position afterward, even if the camera moved.
      entryToSkip = code;
    } else {
      scheduleNext([code]);
    }
    return code;
  };
}
