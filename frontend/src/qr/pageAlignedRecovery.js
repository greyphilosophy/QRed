// Photograph-only fallback for printed QRed watermarks whose page-relative
// QR positions changed during printing. Uses ONLY the camera pixels and public
// QR structural patterns, never the source PDF, plaintext or signing keys.
import jsQR from "jsqr";
import { hiddenPayloadFromScanResult } from "./hiddenPayload.js";
import { readErasedQrMatrix } from "./qrErasureRecovery.js";
import { refineQrModuleGrid } from "./qrAlignmentRefinement.js";

const OFFSETS = [-0.18, 0, 0.18];
const RADIUS = 8, SIGMA = 2.8;
const WEIGHTS = Array.from({ length: RADIUS * 2 + 1 }, (_, i) =>
  Math.exp(-0.5 * ((i - RADIUS) / SIGMA) ** 2));

function luminance(image, x, y) {
  const sx = Math.round(x), sy = Math.round(y);
  if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) return 255;
  const i = (sy * image.width + sx) * 4;
  return (image.data[i] + image.data[i + 1] + image.data[i + 2]) / 3;
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

// Sample the actual printed module centers, averaging nine exposed pixels
// per cell. An inexpensive separable Gaussian estimates local mid-tone from
// neighboring modules, independent of absolute photo exposure and shadows.
function sampleMatrix(image, moduleMap, version) {
  const size = 17 + 4 * version, count = size * size;
  const mean = new Float32Array(count), blurX = new Float32Array(count);
  const bits = new Uint8Array(count), unknown = new Uint8Array(count);
  const confidence = new Uint8Array(count);
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    let total = 0;
    for (const oy of OFFSETS) for (const ox of OFFSETS) {
      const p = moduleMap(col + 0.5 + ox, row + 0.5 + oy);
      total += luminance(image, p.x, p.y);
    }
    mean[row * size + col] = total / 9;
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
    if (Math.abs(delta) < 0.6 || mean[index] < background * 0.63) {
      unknown[index] = 1;
      confidence[index] = Math.max(1, Math.floor(Math.min(9, Math.abs(delta))));
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
export function recoverRefinedQrRegion(image, pageMapping, region, version) {
  if (version < 7 || version > 40) return null;
  const refined = refineQrModuleGrid(image, pageMapping, region, version);
  if (!refined || refined.quality < 0.66) return null;
  const sampled = sampleMatrix(image, refined.moduleMap, version);
  if (versionDistance(sampled.bits, version) > 3) return null;
  const imageQr = raster(sampled);
  const ordinary = jsQR(imageQr.data, imageQr.width, imageQr.width,
    { inversionAttempts: "dontInvert" });
  const location = geometry(refined.moduleMap, sampled.size);
  let seal = ordinary?.version === version && hiddenPayloadFromScanResult(ordinary);
  if (seal) return { seal, code: { ...ordinary, location, pageAligned: true, refined: true } };
  if (!sampled.unknown.some(Boolean)) return null;
  const recovered = readErasedQrMatrix(sampled.bits, sampled.unknown, version, sampled.confidence);
  if (!recovered) return null;
  const code = {
    data: "QRED.ORG", version, correctedData: recovered.correctedData,
    location, pageAligned: true, refined: true, erasureAware: true,
  };
  seal = hiddenPayloadFromScanResult(code);
  return seal ? { seal, code } : null;
}
