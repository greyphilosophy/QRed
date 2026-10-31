// Reed-Solomon erasure recovery for QRed's page-aligned QR matrix decoder.
// Unlike unknown bit errors, confidently identified opaque foreground can
// supply erasure positions: the location of missing information is known.
// This module NEVER bypasses QR parity, document digest or Ed25519 validation.
import Utils from "qrcode/lib/core/utils";
import ECCode from "qrcode/lib/core/error-correction-code";
import ECLevel from "qrcode/lib/core/error-correction-level";
import { codewordsFromMatrix, functionMask } from "./qrLowLevel.js";

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
let value = 1;
for (let i = 0; i < 255; i++) {
  EXP[i] = value;
  LOG[value] = i;
  value <<= 1;
  if (value & 256) value ^= 0x11d;
}
for (let i = 255; i < EXP.length; i++) EXP[i] = EXP[i - 255];
const multiply = (a, b) => a && b ? EXP[LOG[a] + LOG[b]] : 0;
const power = n => EXP[((n % 255) + 255) % 255];
const inverse = a => a ? EXP[255 - LOG[a]] : 0;

function syndromes(block, parityBytes) {
  const result = new Uint8Array(parityBytes);
  for (let k = 0; k < parityBytes; k++) {
    const alpha = power(k);
    let remainder = 0;
    for (const byte of block) remainder = multiply(remainder, alpha) ^ byte;
    result[k] = remainder;
  }
  return result;
}

function solveErasures(block, erasures, parityBytes) {
  const output = Uint8Array.from(block);
  const syndrome = syndromes(output, parityBytes);
  if (syndrome.every(value => value === 0)) return output;
  const count = erasures.size;
  if (!count || count > parityBytes) return null;
  const positions = [...erasures].sort((a, b) => a - b);
  // Vandermonde system over GF(256):
  // S_i = SUM(delta_j * alpha^(i * (N - 1 - position_j))).
  // Erasure positions are codeword indices, NOT module indices.
  const matrix = Array.from({ length: count }, (_, row) =>
    [...positions.map(position => power(row * (output.length - 1 - position))), syndrome[row]]);
  for (let col = 0; col < count; col++) {
    let pivot = col;
    while (pivot < count && !matrix[pivot][col]) pivot++;
    if (pivot === count) return null;
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
    const inv = inverse(matrix[col][col]);
    for (let k = col; k <= count; k++) matrix[col][k] = multiply(matrix[col][k], inv);
    for (let row = 0; row < count; row++) {
      if (row === col) continue;
      const factor = matrix[row][col];
      if (!factor) continue;
      for (let k = col; k <= count; k++) matrix[row][k] ^= multiply(factor, matrix[col][k]);
    }
  }
  positions.forEach((position, index) => { output[position] ^= matrix[index][count]; });
  return syndromes(output, parityBytes).every(value => value === 0) ? output : null;
}

function blockLayout(version, ecLevelBits) {
  const ecLevel = [ECLevel.M, ECLevel.L, ECLevel.H, ECLevel.Q][ecLevelBits];
  if (!ecLevel || version < 1 || version > 40) return null;
  const total = Utils.getSymbolTotalCodewords(version);
  const parity = ECCode.getTotalCodewordsCount(version, ecLevel);
  const blockCount = ECCode.getBlocksCount(version, ecLevel);
  if (!total || !parity || !blockCount || parity % blockCount) return null;
  const data = total - parity, largeBlocks = total % blockCount;
  const smallBlocks = blockCount - largeBlocks;
  const smallDataSize = Math.floor(data / blockCount);
  const parityPerBlock = parity / blockCount;
  const sizes = Array.from({ length: blockCount }, (_, index) =>
    smallDataSize + (index >= smallBlocks ? 1 : 0));
  return { total, sizes, parityPerBlock };
}

export function recoverErasedDataCodewords(codewords, version, ecLevelBits, interleavedErasures = new Set()) {
  const info = blockLayout(version, ecLevelBits);
  if (!info || codewords.length < info.total) return null;
  const blocks = info.sizes.map(size => new Uint8Array(size + info.parityPerBlock));
  const positions = blocks.map(() => new Set());
  let index = 0;
  for (let offset = 0; offset < Math.max(...info.sizes); offset++) {
    for (let block = 0; block < blocks.length; block++) {
      if (offset >= info.sizes[block]) continue;
      blocks[block][offset] = codewords[index];
      if (interleavedErasures.has(index)) positions[block].add(offset);
      index++;
    }
  }
  for (let offset = 0; offset < info.parityPerBlock; offset++) {
    for (let block = 0; block < blocks.length; block++) {
      const target = info.sizes[block] + offset;
      blocks[block][target] = codewords[index];
      if (interleavedErasures.has(index)) positions[block].add(target);
      index++;
    }
  }
  let cursor = 0;
  const output = new Uint8ClampedArray(info.sizes.reduce((a, b) => a + b, 0));
  for (let i = 0; i < blocks.length; i++) {
    const corrected = solveErasures(blocks[i], positions[i], info.parityPerBlock);
    if (!corrected) return null;
    output.set(corrected.subarray(0, info.sizes[i]), cursor);
    cursor += info.sizes[i];
  }
  return output;
}

// Recover codewords from the QR's normal zig-zag interleave. A module is
// uncertain only if the page sampler identified occluding foreground; marks
// in function/format/align patterns never count as RS data erasures.
export function codewordErasureIndexes(unknown, version) {
  const size = 17 + 4 * version;
  if (!unknown || unknown.length !== size * size) return new Set();
  const mask = functionMask(size, version);
  const erased = new Set();
  let bit = 0, upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--;
    for (let offset = 0; offset < size; offset++) {
      const row = upward ? size - 1 - offset : offset;
      for (const col of [right, right - 1]) {
        if (mask[row][col]) continue;
        if (unknown[row * size + col]) erased.add(Math.floor(bit / 8));
        bit++;
      }
    }
    upward = !upward;
  }
  return erased;
}

export function readErasedQrMatrix(bits, unknown, version) {
  const size = 17 + 4 * version;
  if (bits.length !== size * size || unknown.length !== bits.length) return null;
  const matrix = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => Boolean(bits[row * size + col])));
  const { codewords, ecLevelBits } = codewordsFromMatrix(matrix, version);
  const erased = codewordErasureIndexes(unknown, version);
  const data = recoverErasedDataCodewords(codewords, version, ecLevelBits, erased);
  return data && { correctedData: data, interleavedErasures: erased.size };
}
