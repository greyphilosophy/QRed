// A bounded working copy makes rectangular printed QR modules square before
// locating their own public patterns. The retained photo is never modified.
import { locatePaper, pageHomography, pageWatermarkRegions } from "./pageAlignedScan.js";
import { curvedPaperMapping } from "./curvedPaper.js";
import { estimatePaperColor } from "./paperColor.js";
import { normalizeWatermarkLuminance } from "./watermarkFilter.js";
import { readRectifiedQrVersion } from "./rectifiedQrVersion.js";
import { refineQrModuleGrid } from "./qrAlignmentRefinement.js";
import { recoverSampledQrMatrix } from "./pageAlignedRecovery.js";
import { collectModuleSamples, classifyModuleSamples, classifyLocalModuleSamples,
  measureLocalModuleContrast, sharpenModuleLuminance } from "./rectifiedModuleSamples.js";

const MAX_NATIVE_SAMPLE_PIXELS = 12_000_000;
const SIDE = 900, BORDER = 0.04, INTERIOR = 1 - 2 * BORDER;
const finderDark = (row, col) => row === 0 || col === 0 || row === 6 || col === 6 ||
  (row >= 2 && row <= 4 && col >= 2 && col <= 4);

function rectifiedImage(image, mapping, region) {
  const toPhoto = (x, y) => mapping(
    region.x + region.width * ((x + 0.5) / SIDE - BORDER) / INTERIOR,
    region.y + region.height * ((y + 0.5) / SIDE - BORDER) / INTERIOR);
  const data = new Uint8ClampedArray(SIDE * SIDE * 4).fill(255);
  for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) {
    const p = toPhoto(x, y), xx = Math.floor(p.x), yy = Math.floor(p.y);
    if (xx < 0 || yy < 0 || xx + 1 >= image.width || yy + 1 >= image.height) continue;
    const dx = p.x - xx, dy = p.y - yy, input = (yy * image.width + xx) * 4;
    for (let channel = 0; channel < 3; channel++) {
      const at = offset => image.data[offset + channel];
      data[(y * SIDE + x) * 4 + channel] =
        (at(input) * (1 - dx) + at(input + 4) * dx) * (1 - dy) +
        (at(input + image.width * 4) * (1 - dx) + at(input + image.width * 4 + 4) * dx) * dy;
    }
  }
  return { data, width: SIDE, height: SIDE, toPhoto };
}

// Seek each finder independently near the page corners. Dense text can give
// a general-purpose QR locator a better-scoring false triple in mid-page.
function findCorners(gray) {
  const score = (cx, cy, pitch) => {
    let sum = 0, square = 0, pattern = 0, cross = 0, count = 0;
    for (let row = 0; row < 7; row++) for (let col = 0; col < 7; col++) {
      const x = Math.round(cx + (col - 3) * pitch), y = Math.round(cy + (row - 3) * pitch);
      if (x < 0 || y < 0 || x >= SIDE || y >= SIDE) return -1;
      const value = gray[y * SIDE + x];
      if (value < 160) continue;
      const expected = finderDark(row, col) ? -1 : 1;
      sum += value; square += value * value; pattern += expected;
      cross += value * expected; count++;
    }
    const variance = square - sum * sum / count;
    return count >= 40 && variance > 25 * count
      ? (cross - sum * pattern / count) / Math.sqrt(variance * (count - pattern * pattern / count)) : -1;
  };
  return [[0, 0], [1, 0], [0, 1]].map(([right, bottom]) => {
    let best = { score: -1 };
    for (let version = 7; version <= 40; version++) {
      const pitch = SIDE * INTERIOR / (17 + 4 * version);
      const x = right ? SIDE * (1 - BORDER) - 3.5 * pitch : SIDE * BORDER + 3.5 * pitch;
      const y = bottom ? SIDE * (1 - BORDER) - 3.5 * pitch : SIDE * BORDER + 3.5 * pitch;
      for (let dy = -24; dy <= 24; dy += 3) for (let dx = -24; dx <= 24; dx += 3) {
        const value = score(x + dx, y + dy, pitch);
        if (value > best.score) best = { score: value, x: x + dx, y: y + dy, pitch };
      }
    }
    const seed = best;
    for (let dy = -2; dy <= 2; dy += 0.5) for (let dx = -2; dx <= 2; dx += 0.5)
      for (const scale of [0.97, 0.985, 1, 1.015, 1.03]) {
        const value = score(seed.x + dx, seed.y + dy, seed.pitch * scale);
        if (value > best.score) best = {
          score: value, x: seed.x + dx, y: seed.y + dy, pitch: seed.pitch * scale,
        };
      }
    return best;
  });
}

function measuredThreshold(gray, corners) {
  const dark = [], light = [];
  for (const p of corners) for (let row = 0; row < 7; row++) for (let col = 0; col < 7; col++) {
    const x = Math.round(p.x + (col - 3) * p.pitch), y = Math.round(p.y + (row - 3) * p.pitch);
    const value = gray[y * SIDE + x];
    if (value >= 160) (finderDark(row, col) ? dark : light).push(value);
  }
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  return Math.round((median(dark) + median(light)) / 2);
}

function recoverObservations(observations, photoMap, version, thresholds, shouldContinue) {
  for (const threshold of thresholds) for (const foreground of [160, 180]) {
    if (!shouldContinue()) return null;
    const sampled = classifyModuleSamples(observations, threshold, foreground);
    const recovered = recoverSampledQrMatrix(sampled, photoMap, version,
      { allowSingleBitError: true, allowRankedErasures: false });
    if (recovered) return recovered;
  }
  for (const radius of [8, 12]) {
    if (!shouldContinue()) return null;
    // Preserve the narrow estimate first. A wider neighborhood is less
    // sensitive to foreground/resampling; reuse it for two nearby cuts.
    const contrast = measureLocalModuleContrast(observations, { radius, shouldContinue });
    if (!contrast) return null;
    for (const thresholdFraction of radius === 8 ? [0.5] : [0.5, 0.4]) {
      const local = classifyLocalModuleSamples(observations,
        { contrast, thresholdFraction, shouldContinue });
      if (!local || !shouldContinue()) return null;
      const recovered = recoverSampledQrMatrix(local, photoMap, version,
        { allowSingleBitError: true, allowRankedErasures: false });
      if (recovered) return recovered;
    }
  }
  return null;
}

// Share only measured preparation within one frozen photo request. The wider
// retry must not rebuild the same page warp, normalized pixels and finder
// observations after the earlier narrow search has already paid for them.
// This closure is never retained across photographs or camera frames.
export function createRectifiedSealScanner(source, { curved = false } = {}) {
  let image = null, mapping = null;
  let originalGray = null, sharpenedGray = null;
  const prepared = new Map();
  const profiles = [{ marginPoints: 54 }, { marginPoints: 36 }, { legacy: true }];

  function prepare(profile) {
    if (prepared.has(profile)) return prepared.get(profile);
    const region = pageWatermarkRegions(1, undefined, profile)[0];
    const working = rectifiedImage(image, mapping, region);
    const gray = normalizeWatermarkLuminance(working.data, SIDE, SIDE), corners = findCorners(gray);
    if (corners.some(p => p.score < 0.8)) { prepared.set(profile, null); return null; }
    const version = readRectifiedQrVersion(gray, SIDE, corners);
    if (!version) { prepared.set(profile, null); return null; }
    const size = 17 + 4 * version, [tl, tr, bl] = corners;
    const gridMap = (u, v) => ({
      x: tl.x + (u * size - 3.5) * (tr.x - tl.x) / (size - 7) + (v * size - 3.5) * (bl.x - tl.x) / (size - 7),
      y: tl.y + (u * size - 3.5) * (tr.y - tl.y) / (size - 7) + (v * size - 3.5) * (bl.y - tl.y) / (size - 7),
    });
    const thresholds = [...new Set([230, measuredThreshold(gray, corners)])];
    const candidate = { working, gray, version, gridMap, thresholds };
    prepared.set(profile, candidate);
    return candidate;
  }

  return function scan({ shouldContinue = () => true, searchRadius = 39 } = {}) {
    if (source.width < 160 || source.height < 160 || !shouldContinue()) return null;
    if (!image) {
      image = { data: source.data, width: source.width, height: source.height,
        paperColor: estimatePaperColor(source) };
      if (curved) mapping = curvedPaperMapping(image, shouldContinue);
      else {
        const quad = locatePaper(image);
        mapping = quad && pageHomography(quad);
      }
    }
    if (!mapping) return null;
    for (const profile of profiles) {
      if (!shouldContinue()) break;
      const candidate = prepare(profile);
      if (!candidate) continue;
      const { working, gray, version, gridMap, thresholds } = candidate;
      for (const foregroundRobust of [true, false]) {
        if (!shouldContinue()) break;
        const grid = refineQrModuleGrid(working, gridMap, { x: 0, y: 0, width: 1, height: 1 },
          version, { foregroundRobust, searchRadius, shouldContinue, measuredFinders: foregroundRobust });
        if (!grid || grid.quality < 0.66) continue;
        // Prefer the observed finders when extrapolation moved by half a module.
        // Keep the alignment-only map as the alternate in case the finders were noisy.
        const maps = grid.finderModuleMap ? [grid.finderModuleMap, grid.moduleMap] : [grid.moduleMap];
        for (const moduleMap of maps) {
          if (!shouldContinue()) return null;
          const observations = collectModuleSamples(gray, SIDE, SIDE, moduleMap, version);
          const photoMap = (col, row) => {
            const p = moduleMap(col, row);
            return working.toPhoto(p.x, p.y);
          };
          const recovered = recoverObservations(observations, photoMap, version, thresholds, shouldContinue);
          if (recovered) return recovered;
          if (!shouldContinue()) return null;
          // Keep fitting public QR patterns on the bounded square copy, but do
          // not require its resampling blur to determine the observed modules.
          // Smaller camera frames can lose the narrow gap between pale QR ink
          // and text when warped a second time. Read the original pixels through
          // that same measured map only after the established fast path misses.
          if (image.width * image.height > MAX_NATIVE_SAMPLE_PIXELS) continue;
          originalGray ??= normalizeWatermarkLuminance(image.data, image.width, image.height);
          if (!shouldContinue()) return null;
          const native = collectModuleSamples(originalGray, image.width, image.height, photoMap, version);
          const nativeRecovered = recoverObservations(native, photoMap, version, thresholds, shouldContinue);
          if (nativeRecovered) return nativeRecovered;
          if (!shouldContinue()) return null;
          // Bilinear camera resizing can soften the native modules too. Allow
          // one measured edge-emphasis retry, still under the shared deadline.
          sharpenedGray ??= sharpenModuleLuminance(originalGray, image.width, image.height, { shouldContinue });
          if (!sharpenedGray || !shouldContinue()) return null;
          const sharp = collectModuleSamples(sharpenedGray, image.width, image.height, photoMap, version);
          const sharpRecovered = recoverObservations(sharp, photoMap, version, thresholds, shouldContinue);
          if (sharpRecovered) return sharpRecovered;
        }
      }
    }
    return null;
  };
}

// One-off callers keep the original API and do not share request state.
export function scanRectifiedSeal(image, options) {
  return createRectifiedSealScanner(image)(options);
}

export function scanCurvedPageSeal(image, options) {
  return createRectifiedSealScanner(image, { curved: true })(options);
}
