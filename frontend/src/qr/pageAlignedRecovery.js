// Photograph-only fallback for printed QRed watermarks whose page-relative
// QR positions changed during printing. Uses ONLY the camera pixels and public
// QR structural patterns, never the source PDF, plaintext or signing keys.
import jsQR from "jsqr";
import { hiddenPayloadFromScanResult } from "./hiddenPayload.js";
import { readErasedQrMatrix } from "./qrErasureRecovery.js";
import { refineQrModuleGrid } from "./qrAlignmentRefinement.js";
import { photoLuminance } from "./paperColor.js";

const OFFSETS = [-0.3, -0.15, 0, 0.15, 0.3];
const MEAN_OFFSETS = [-0.18, 0, 0.18];
const RADIUS = 8, SIGMA = 2.8;
const WEIGHTS = Array.from({ length: RADIUS * 2 + 1 }, (_, i) =>
  Math.exp(-0.5 * ((i - RADIUS) / SIGMA) ** 2));

function luminance(image, x, y) {
  const sx = Math.round(x), sy = Math.round(y);
  if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) return 255;
  const i = (sy * image.width + sx) * 4;
  return photoLuminance(image, i);
}
function finderDark(row, col) {
  return row === 0 || row === 6 || col === 0 || col === 6 ||
    (row >= 2 && row <= 4 && col >= 2 && col <= 4);
}
function restoreFunctions(bits, size) {
  const finder = (x0, y0) => {
    for (let row = -1; row <= 7; row++) for (let col = -1; col <= 7; col++) {
      const x = x0 + col, y = y0 + row;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      bits[y * size + x] = Number(row >= 0 && row < 7 && col >= 0 && col < 7 &&
        finderDark(row, col));
    }
  };
  finder(0, 0); finder(size - 7, 0); finder(0, size - 7);
  for (let i = 8; i < size - 8; i++) {
    bits[6 * size + i] = Number(i % 2 === 0);
    bits[i * size + 6] = Number(i % 2 === 0);
  }
}

// On the foreground retry, read 25 interior pixels per module. Average the
// brightest fifth only where a dark stroke is present; elsewhere retain the
// full mean so a stray bright edge pixel cannot erase pale QR ink. Dark
// letter strokes must not drag down either the module decision or its local
// mid-tone estimate. The within-cell range also records foreground evidence
// for parity recovery, even when a few exposed pixels remain readable.
export function sampleRefinedQrMatrix(image, moduleMap, version, { foregroundRobust = false } = {}) {
  const size = 17 + 4 * version, count = size * size;
  const mean = new Float32Array(count), blurX = new Float32Array(count);
  const bits = new Uint8Array(count), unknown = new Uint8Array(count);
  const confidence = new Uint8Array(count), foreground = new Uint8Array(count);
  const offsets = foregroundRobust ? OFFSETS : MEAN_OFFSETS;
  const samples = new Float32Array(offsets.length ** 2);
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    let index = 0;
    for (const oy of offsets) for (const ox of offsets) {
      const p = moduleMap(col + 0.5 + ox, row + 0.5 + oy);
      samples[index++] = luminance(image, p.x, p.y);
    }
    if (foregroundRobust) samples.sort();
    const covered = foregroundRobust && samples[0] < samples[samples.length - 1] * 0.8;
    let total = 0;
    const exposedCount = covered ? 5 : samples.length;
    for (let i = samples.length - exposedCount; i < samples.length; i++) total += samples[i];
    mean[row * size + col] = total / exposedCount;
    foreground[row * size + col] = Number(covered);
  }
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    let total = 0, weight = 0;
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      const x = col + dx; if (x < 0 || x >= size) continue;
      const w = WEIGHTS[dx + RADIUS];
      total += mean[row * size + x] * w;
      weight += w;
    }
    blurX[row * size + col] = total / weight;
  }
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    let total = 0, weight = 0;
    for (let dy = -RADIUS; dy <= RADIUS; dy++) {
      const y = row + dy; if (y < 0 || y >= size) continue;
      const w = WEIGHTS[dy + RADIUS];
      total += blurX[y * size + col] * w;
      weight += w;
    }
    const index = row * size + col, background = total / weight;
    const delta = background - mean[index];
    bits[index] = Number(delta > 0);
    const ambiguous = Math.abs(delta) < (foregroundRobust ? 1.2 : 0.6);
    if (ambiguous || mean[index] < background * (foregroundRobust ? 0.8 : 0.63) || foreground[index]) {
      unknown[index] = 1;
      confidence[index] = foregroundRobust
        ? (foreground[index] ? 9 : Math.max(1, Math.floor(9 - Math.abs(delta))))
        : Math.max(1, Math.floor(Math.min(9, Math.abs(delta))));
    }
  }
  restoreFunctions(bits, size);
  return { bits, unknown, confidence, size };
}

// QR versions >=7 encode the 6-bit version in two copies of an 18-bit
// BCH-protected field. Wrong grid dimensions fail before RS or signature work.
function encodedVersion(version) {
  let remainder = version << 12;
  for (let bit = 17; bit >= 12; bit--)
    if ((remainder >>> bit) & 1) remainder ^= 0x1f25 << (bit - 12);
  return (version << 12) | remainder;
}
function versionDistance(bits, version) {
  const size = 17 + 4 * version, encoded = encodedVersion(version);
  let topRight = 0, bottomLeft = 0;
  for (let i = 0; i < 18; i++) {
    const row = Math.floor(i / 3), col = size - 11 + i % 3;
    const expected = (encoded >>> i) & 1;
    topRight += Number(bits[row * size + col] !== expected);
    bottomLeft += Number(bits[col * size + row] !== expected);
  }
  return Math.min(topRight, bottomLeft);
}
function raster({ bits, size }) {
  const unit = 4, width = (size + 8) * unit;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    if (!bits[row * size + col]) continue;
    for (let y = (row + 4) * unit; y < (row + 5) * unit; y++)
      for (let x = (col + 4) * unit; x < (col + 5) * unit; x++) {
        const i = (y * width + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
  }
  return { data, width };
}
function geometry(map, size) {
  const at = (row, col) => map(col, row);
  return {
    topLeftCorner: at(0, 0), topRightCorner: at(0, size),
    bottomLeftCorner: at(size, 0), bottomRightCorner: at(size, size),
    topLeftFinderPattern: at(3.5, 3.5),
    topRightFinderPattern: at(3.5, size - 3.5),
    bottomLeftFinderPattern: at(size - 3.5, 3.5),
  };
}

// Called only by the bounded static-photo/manual-capture recovery fallback.
// Each code remains subject to normal hidden-payload and Ed25519 verification.
function recoverWithSampling(image, pageMapping, region, version, foregroundRobust) {
  const refined = refineQrModuleGrid(image, pageMapping, region, version, { foregroundRobust });
  if (!refined || refined.quality < 0.66) return null;
  const sampled = sampleRefinedQrMatrix(image, refined.moduleMap, version, { foregroundRobust });
  if (versionDistance(sampled.bits, version) > 3) return null;
  const imageQr = raster(sampled);
  const ordinary = jsQR(imageQr.data, imageQr.width, imageQr.width,
    { inversionAttempts: "dontInvert" });
  const location = geometry(refined.moduleMap, sampled.size);
  let seal = ordinary?.version === version && hiddenPayloadFromScanResult(ordinary);
  if (seal) return { seal, code: { ...ordinary, location, pageAligned: true, refined: true } };
  if (!sampled.unknown.some(Boolean)) return null;
  const recovered = readErasedQrMatrix(sampled.bits, sampled.unknown, version, sampled.confidence,
    { allowSingleBitError: foregroundRobust, allowRankedErasures: !foregroundRobust });
  if (!recovered) return null;
  const code = {
    data: "QRED.ORG", version, correctedData: recovered.correctedData,
    location, pageAligned: true, refined: true, erasureAware: true,
  };
  seal = hiddenPayloadFromScanResult(code);
  return seal ? { seal, code } : null;
}

export function recoverRefinedQrRegion(image, pageMapping, region, version) {
  if (version < 7 || version > 40) return null;
  // Keep the established narrow-center pass for clean/faint-text prints.
  // Each bounded region attempt has at most one text-resistant retry; broad
  // sampling must not replace a working low-noise reconstruction.
  return recoverWithSampling(image, pageMapping, region, version, false) ||
    recoverWithSampling(image, pageMapping, region, version, true);
}
