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


// Remove known erasure contributions from the syndromes before locating any
// additional unknown-position errors. Multiplying the syndrome sequence by
// (x + alpha^(N-1-position)) cancels that erasure's contribution.
function withoutKnownErasures(syndrome, locations, length) {
  const values = Array.from(syndrome);
  for (const position of locations) {
    const factor = power(length - 1 - position);
    for (let i = 0; i < values.length - 1; i++) {
      values[i] = multiply(values[i], factor) ^ values[i + 1];
    }
    values.pop();
  }
  return values;
}

// Berlekamp-Massey determines the few remaining unknown error locations;
// once ALL locations are known, the same Vandermonde solver recovers bytes.
function unknownErrors(syndrome, erasures, length, parityBytes) {
  const residual = withoutKnownErasures(syndrome, erasures, length);
  let locator = [1], previous = [1], degree = 0, shift = 1, last = 1;
  for (let step = 0; step < residual.length; step++) {
    let discrepancy = residual[step];
    for (let i = 1; i <= degree; i++) {
      discrepancy ^= multiply(locator[i] ?? 0, residual[step - i]);
    }
    if (!discrepancy) { shift++; continue; }
    const old = locator.slice(), scale = multiply(discrepancy, inverse(last));
    while (locator.length < previous.length + shift) locator.push(0);
    for (let i = 0; i < previous.length; i++) {
      locator[i + shift] ^= multiply(scale, previous[i]);
    }
    if (2 * degree <= step) {
      degree = step + 1 - degree;
      previous = old; last = discrepancy; shift = 1;
    } else shift++;
  }
  if (2 * degree + erasures.size > parityBytes) return null;
  if (!degree) return [];
  const evaluate = x => locator.reduceRight((acc, coefficient) => multiply(acc, x) ^ coefficient, 0);
  const errors = [];
  for (let position = 0; position < length; position++) {
    if (erasures.has(position)) continue;
    if (!evaluate(power(-(length - 1 - position)))) errors.push(position);
  }
  return errors.length === degree ? errors : null;
}

function solveErasures(block, erasures, parityBytes) {
  const output = Uint8Array.from(block);
  const syndrome = syndromes(output, parityBytes);
  if (syndrome.every(value => value === 0)) return output;
  if (erasures.size > parityBytes) return null;
  const errors = unknownErrors(syndrome, erasures, output.length, parityBytes);
  if (errors === null) return null;
  const count = erasures.size + errors.length;
  if (!count || count > parityBytes) return null;
  const positions = [...erasures, ...errors].sort((a, b) => a - b);
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

function separateBlocks(codewords, info) {
  const blocks = info.sizes.map(size => new Uint8Array(size + info.parityPerBlock));
  const indexes = blocks.map(block => new Array(block.length));
  let cursor = 0;
  for (let offset = 0; offset < Math.max(...info.sizes); offset++) {
    for (let block = 0; block < blocks.length; block++) {
      if (offset >= info.sizes[block]) continue;
      blocks[block][offset] = codewords[cursor];
      indexes[block][offset] = cursor++;
    }
  }
  for (let offset = 0; offset < info.parityPerBlock; offset++) {
    for (let block = 0; block < blocks.length; block++) {
      const position = info.sizes[block] + offset;
      blocks[block][position] = codewords[cursor];
      indexes[block][position] = cursor++;
    }
  }
  return { blocks, indexes };
}

function dataFromBlocks(blocks, sizes) {
  const data = new Uint8ClampedArray(sizes.reduce((sum, length) => sum + length, 0));
  let offset = 0;
  for (let i = 0; i < blocks.length; i++) {
    data.set(blocks[i].subarray(0, sizes[i]), offset);
    offset += sizes[i];
  }
  return data;
}

export function recoverErasedDataCodewords(codewords, version, ecLevelBits, interleavedErasures = new Set()) {
  const info = blockLayout(version, ecLevelBits);
  if (!info || codewords.length < info.total) return null;
  const { blocks, indexes } = separateBlocks(codewords, info);
  const corrected = [];
  for (let i = 0; i < blocks.length; i++) {
    const positions = new Set(indexes[i].flatMap((global, local) =>
      interleavedErasures.has(global) ? [local] : []));
    const fixed = solveErasures(blocks[i], positions, info.parityPerBlock);
    if (!fixed) return null;
    corrected.push(fixed);
  }
  return dataFromBlocks(corrected, info.sizes);
}

// Soft erasures: a wholly text-covered byte is less trustworthy than a byte
// with a single ambiguous sample. Spend the limited parity symbols on the
// highest-risk bytes first, and use BM for any unmarked residual errors.
export function recoverRankedErasedCodewords(codewords, version, ecLevelBits, riskScores) {
  const info = blockLayout(version, ecLevelBits);
  if (!info || codewords.length < info.total || riskScores.length < info.total) return null;
  const { blocks, indexes } = separateBlocks(codewords, info);
  const corrected = [];
  for (let i = 0; i < blocks.length; i++) {
    const candidates = indexes[i].map((global, local) => ({ local, risk: riskScores[global] || 0 }))
      .filter(item => item.risk > 0)
      .sort((a, b) => b.risk - a.risk || a.local - b.local);
    const ec = info.parityPerBlock, total = candidates.length;
    const budgets = [...new Set([
      Math.min(total, ec - 6), Math.min(total, ec - 8),
      Math.min(total, ec - 4), Math.min(total, ec - 10),
      Math.min(total, Math.floor(total * 0.7)),
      Math.min(total, ec - 2), Math.min(total, ec),
      Math.min(total, ec - 12), 0,
    ].filter(value => value >= 0))];
    let fixed = null;
    for (const size of budgets) {
      const positions = new Set(candidates.slice(0, size).map(item => item.local));
      fixed = solveErasures(blocks[i], positions, ec);
      if (fixed) break;
    }
    if (!fixed) return null;
    corrected.push(fixed);
  }
  return dataFromBlocks(corrected, info.sizes);
}

// Solve QR parity directly for missing *bits*, not entire codewords.
// A one-bit occlusion costs one GF(2) unknown rather than one GF(256) byte.
// QR's thirty parity symbols per RS block provide 240 binary constraints.
function solveBitErasures(block, erasedBits, parityBytes) {
  const syndrome = syndromes(block, parityBytes);
  if (syndrome.every(value => value === 0)) return Uint8Array.from(block);
  const count = erasedBits.length;
  const equations = parityBytes * 8;
  if (!count || count > equations) return null;
  const words = Math.ceil((count + 1) / 32);
  const rows = Array.from({ length: equations }, () => new Uint32Array(words));
  const rhsWord = count >>> 5, rhsBit = (1 << (count & 31));
  for (let k = 0; k < parityBytes; k++) {
    for (let bit = 0; bit < 8; bit++) {
      if (syndrome[k] & (1 << bit)) rows[k * 8 + bit][rhsWord] |= rhsBit;
    }
  }
  for (let i = 0; i < count; i++) {
    const { position, mask } = erasedBits[i];
    const word = i >>> 5, bitFlag = 1 << (i & 31);
    const exponent = block.length - 1 - position;
    for (let k = 0; k < parityBytes; k++) {
      const contribution = multiply(mask, power(k * exponent));
      for (let bit = 0; bit < 8; bit++) {
        if (contribution & (1 << bit)) rows[k * 8 + bit][word] |= bitFlag;
      }
    }
  }
  const bitAt = (row, index) => Boolean(row[index >>> 5] & (1 << (index & 31)));
  let pivotRow = 0;
  for (let col = 0; col < count; col++) {
    let selected = pivotRow;
    while (selected < equations && !bitAt(rows[selected], col)) selected++;
    if (selected === equations) return null; // Underdetermined; fail closed.
    [rows[pivotRow], rows[selected]] = [rows[selected], rows[pivotRow]];
    for (let row = pivotRow + 1; row < equations; row++) {
      if (!bitAt(rows[row], col)) continue;
      for (let word = 0; word < words; word++) rows[row][word] ^= rows[pivotRow][word];
    }
    pivotRow++;
  }
  for (let row = count; row < equations; row++) {
    if (bitAt(rows[row], count)) return null; // Inconsistent with observed bits.
  }
  const corrections = new Uint8Array(count);
  for (let i = count - 1; i >= 0; i--) {
    let value = Number(bitAt(rows[i], count));
    for (let col = i + 1; col < count; col++) {
      if (corrections[col] && bitAt(rows[i], col)) value ^= 1;
    }
    corrections[i] = value;
  }
  const corrected = Uint8Array.from(block);
  erasedBits.forEach(({ position, mask }, i) => {
    if (corrections[i]) corrected[position] ^= mask;
  });
  return syndromes(corrected, parityBytes).every(value => value === 0) ? corrected : null;
}

// The input is one bit mask per interleaved QR codeword, with bit 7 the
// leftmost bit. No source document or expected payload enters this process.
export function recoverBitErasedDataCodewords(codewords, version, ecLevelBits, interleavedBitMasks) {
  const info = blockLayout(version, ecLevelBits);
  if (!info || codewords.length < info.total || interleavedBitMasks.length < info.total) return null;
  const { blocks, indexes } = separateBlocks(codewords, info);
  const corrected = [];
  for (let i = 0; i < blocks.length; i++) {
    const missing = [];
    for (let position = 0; position < indexes[i].length; position++) {
      const mask = interleavedBitMasks[indexes[i][position]];
      for (let bit = 0; bit < 8; bit++) {
        if (mask & (1 << bit)) missing.push({ position, mask: 1 << bit });
      }
    }
    const fixed = solveBitErasures(blocks[i], missing, info.parityPerBlock);
    if (!fixed) return null;
    corrected.push(fixed);
  }
  return dataFromBlocks(corrected, info.sizes);
}

function moduleBitErasureMasks(unknown, version, codewordCount) {
  const size = 17 + 4 * version;
  const reserved = functionMask(size, version);
  const masks = new Uint8Array(codewordCount);
  let bit = 0, upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--;
    for (let offset = 0; offset < size; offset++) {
      const row = upward ? size - 1 - offset : offset;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        if ((bit >>> 3) < masks.length && unknown[row * size + col]) {
          masks[bit >>> 3] |= 1 << (7 - (bit & 7));
        }
        bit++;
      }
    }
    upward = !upward;
  }
  return masks;
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

export function readErasedQrMatrix(bits, unknown, version, confidence = null) {
  const size = 17 + 4 * version;
  if (bits.length !== size * size || unknown.length !== bits.length) return null;
  const matrix = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => Boolean(bits[row * size + col])));
  const { codewords, ecLevelBits } = codewordsFromMatrix(matrix, version);
  const erased = codewordErasureIndexes(unknown, version);
  const bitMasks = moduleBitErasureMasks(unknown, version, codewords.length);
  let data = recoverBitErasedDataCodewords(codewords, version, ecLevelBits, bitMasks);
  if (!data) data = recoverErasedDataCodewords(codewords, version, ecLevelBits, erased);
  if (!data && erased.size) {
    const risk = new Uint16Array(codewords.length);
    const quality = confidence?.length === unknown.length ? confidence : unknown;
    const reserved = functionMask(size, version);
    let bit = 0, upward = true;
    for (let right = size - 1; right > 0; right -= 2) {
      if (right === 6) right--;
      for (let offset = 0; offset < size; offset++) {
        const row = upward ? size - 1 - offset : offset;
        for (const col of [right, right - 1]) {
          if (reserved[row][col]) continue;
          if (bit >> 3 < risk.length) risk[bit >> 3] += quality[row * size + col];
          bit++;
        }
      }
      upward = !upward;
    }
    data = recoverRankedErasedCodewords(codewords, version, ecLevelBits, risk);
  }
  return data && { correctedData: data, interleavedErasures: erased.size };
}
