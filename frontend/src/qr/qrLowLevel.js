// QRed — QR format / mask / matrix helpers
// Single source of truth for low-level QR bit manipulation.
// Used by qredVerifier.js (via qrcode lib) and testAnalyzer (standalone table-based).

export function bitAt(matrix, row, col) {
  return matrix[row]?.[col] ? 1 : 0;
}

export function formatBitPositions(size) {
  const first = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  const second = [[size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8], [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]];
  return [first, second];
}

export function readFormatBits(matrix) {
  const [first, second] = formatBitPositions(matrix.length);
  return [first, second].map((positions) => positions.reduce((value, [row, col]) => (value << 1) | bitAt(matrix, row, col), 0));
}

export function formatHammingDistance(a, b) {
  let diff = a ^ b;
  let count = 0;
  while (diff) {
    count += 1;
    diff &= diff - 1;
  }
  return count;
}

export function qrMaskBit(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return false;
  }
}

// ISO 18004 format info codewords
const FORMAT_CODEWORDS = [
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
  0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b,
  0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed,
];

export function decodeFormatInfo(matrix) {
  let best = { distance: Infinity, index: -1 };
  for (const read of readFormatBits(matrix)) {
    for (let index = 0; index < FORMAT_CODEWORDS.length; index += 1) {
      const distance = formatHammingDistance(read, FORMAT_CODEWORDS[index]);
      if (distance < best.distance) best = { distance, index };
    }
  }
  if (best.distance > 3) return null;
  return { ecLevelBits: Math.floor(best.index / 8), maskPattern: best.index % 8 };
}

export function alignmentCenters(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil(((version * 4 + 4) / (count * 2 - 2))) * 2;
  const centers = [6];
  for (let pos = 17 + 4 * version - 7; centers.length < count; pos -= step) centers.splice(1, 0, pos);
  return centers;
}

export function functionMask(size, version) {
  const mask = Array.from({ length: size }, () => Array(size).fill(false));
  const mark = (r0, c0, h, w) => {
    for (let r = Math.max(0, r0); r < Math.min(size, r0 + h); r += 1)
      for (let c = Math.max(0, c0); c < Math.min(size, c0 + w); c += 1)
        mask[r][c] = true;
  };
  mark(0, 0, 9, 9); mark(0, size - 8, 9, 8); mark(size - 8, 0, 8, 9);
  mark(6, 0, 1, size); mark(0, 6, size, 1);
  for (const r of alignmentCenters(version))
    for (const c of alignmentCenters(version)) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      mark(r - 2, c - 2, 5, 5);
    }
  if (version >= 7) { mark(0, size - 11, 6, 3); mark(size - 11, 0, 3, 6); }
  return mask;
}

export function codewordsFromMatrix(matrix, version) {
  const size = matrix.length;
  const formatInfo = decodeFormatInfo(matrix);
  if (!formatInfo) return { codewords: new Uint8Array(), ecLevelBits: 0 };
  const reserved = functionMask(size, version);
  const bits = [];
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1;
    for (let vertical = 0; vertical < size; vertical += 1) {
      const row = upward ? size - 1 - vertical : vertical;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        bits.push(bitAt(matrix, row, col) ^ (qrMaskBit(formatInfo.maskPattern, row, col) ? 1 : 0));
      }
    }
    upward = !upward;
  }
  const bytes = [];
  for (let i = 0; i + 7 < bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
  return { codewords: new Uint8Array(bytes), ecLevelBits: formatInfo.ecLevelBits };
}

// ── Module-count lookups (used by test.html and qr planning) ──
export const QR_MODULE_COUNT_BY_VERSION = [
  0, 21, 25, 29, 33, 37, 41, 45, 49, 53, 57, 61, 65, 69, 73, 77, 81, 85, 89,
  93, 97, 101, 105, 109, 113, 117, 121, 125, 129, 133, 137, 141, 145, 149, 153,
  157, 161, 165, 169, 173, 177, 181
];

// Tables for standalone analyzer (no qrcode lib)
export const TOTAL_CODEWORDS = [
  0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085, 1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706
];
export const EC_BLOCKS_BY_LEVEL = [
  [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
];
export const EC_CODEWORDS_BY_LEVEL = [
  [0, 10, 16, 26, 36, 48, 64, 72, 88, 110, 130, 150, 176, 198, 216, 240, 280, 308, 338, 364, 416, 442, 476, 504, 560, 588, 644, 700, 728, 784, 812, 868, 924, 980, 1036, 1064, 1120, 1204, 1260, 1316, 1372],
  [0, 7, 10, 15, 20, 26, 36, 40, 48, 60, 72, 80, 96, 104, 120, 132, 144, 168, 180, 196, 224, 224, 252, 270, 300, 312, 336, 360, 390, 420, 450, 480, 510, 540, 570, 570, 600, 630, 660, 720, 750],
  [0, 17, 28, 44, 64, 88, 112, 130, 156, 192, 224, 264, 308, 352, 384, 432, 480, 532, 588, 650, 700, 750, 816, 900, 960, 1050, 1110, 1200, 1260, 1350, 1440, 1530, 1620, 1710, 1800, 1890, 1980, 2100, 2220, 2310, 2430],
  [0, 13, 22, 36, 52, 72, 96, 108, 132, 160, 192, 224, 260, 288, 320, 360, 408, 448, 504, 546, 600, 644, 690, 750, 810, 870, 952, 1020, 1050, 1140, 1200, 1290, 1350, 1440, 1530, 1590, 1680, 1770, 1860, 1950, 2040],
];

export function deinterleaveDataCodewordsWithTables(interleaved, version, ecLevelBits = 0) {
  const totalCodewords = TOTAL_CODEWORDS[version];
  const ecTotalCodewords = EC_CODEWORDS_BY_LEVEL[ecLevelBits]?.[version];
  const ecTotalBlocks = EC_BLOCKS_BY_LEVEL[ecLevelBits]?.[version];
  if (!totalCodewords || !ecTotalCodewords || interleaved.length < totalCodewords || !ecTotalBlocks) return interleaved;
  const dataTotalCodewords = totalCodewords - ecTotalCodewords;
  const blocksInGroup2 = totalCodewords % ecTotalBlocks;
  const blocksInGroup1 = ecTotalBlocks - blocksInGroup2;
  const dataCodewordsInGroup1 = Math.floor(dataTotalCodewords / ecTotalBlocks);
  const dataCodewordsInGroup2 = dataCodewordsInGroup1 + 1;
  const blocks = Array.from({ length: ecTotalBlocks }, (_, blockNum) =>
    new Uint8Array(blockNum < blocksInGroup1 ? dataCodewordsInGroup1 : dataCodewordsInGroup2));
  let offset = 0;
  for (let i = 0; i < dataCodewordsInGroup2; i += 1) {
    for (let block = 0; block < ecTotalBlocks; block += 1) {
      if (i < blocks[block].length) {
        blocks[block][i] = interleaved[offset];
        offset += 1;
      }
    }
  }
  const data = new Uint8Array(dataTotalCodewords);
  offset = 0;
  for (const block of blocks) {
    data.set(block, offset);
    offset += block.length;
  }
  return data;
}

// qrcode-lib backed deinterleave (for browser verifier path where qrcode dep is present)
export function deinterleaveDataCodewordsWithQrLib(interleaved, version, ecLevelBits, { Utils, ECCode, ECLevel }) {
  if (!Utils || !ECCode || !ECLevel) return interleaved;
  const totalCodewords = Utils.getSymbolTotalCodewords(version);
  const ecLevel = [ECLevel.M, ECLevel.L, ECLevel.H, ECLevel.Q][ecLevelBits] || ECLevel.M;
  const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, ecLevel);
  const ecTotalBlocks = ECCode.getBlocksCount(version, ecLevel);
  if (!totalCodewords || !ecTotalCodewords || interleaved.length < totalCodewords || !ecTotalBlocks) return interleaved;
  const dataTotalCodewords = totalCodewords - ecTotalCodewords;
  const blocksInGroup2 = totalCodewords % ecTotalBlocks;
  const blocksInGroup1 = ecTotalBlocks - blocksInGroup2;
  const dataCodewordsInGroup1 = Math.floor(dataTotalCodewords / ecTotalBlocks);
  const dataCodewordsInGroup2 = dataCodewordsInGroup1 + 1;
  const blocks = Array.from({ length: ecTotalBlocks }, (_, block) => new Uint8Array(block < blocksInGroup1 ? dataCodewordsInGroup1 : dataCodewordsInGroup2));
  let offset = 0;
  for (let i = 0; i < dataCodewordsInGroup2; i += 1) {
    for (let block = 0; block < ecTotalBlocks; block += 1) {
      if (i < blocks[block].length) {
        blocks[block][i] = interleaved[offset];
        offset += 1;
      }
    }
  }
  const data = new Uint8Array(dataTotalCodewords);
  offset = 0;
  for (const block of blocks) {
    data.set(block, offset);
    offset += block.length;
  }
  return data;
}
