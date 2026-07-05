import { verifyAsync as verifyEd25519 } from "@noble/ed25519";
import { decodeB45ish } from "./textRecipes.js";

export const VISIBLE_QR_TEXT = "QRED.ORG";
const HIDDEN_PAYLOAD_LENGTH_BYTES = 2;

function bytesFrom(value) {
  if (!value) return new Uint8Array();
  return value instanceof Uint8Array ? value : Uint8Array.from(value);
}

function alphanumericDataBitLength(text) {
  const pairs = Math.floor(text.length / 2);
  const remainder = text.length % 2;
  return (pairs * 11) + (remainder * 6);
}

function qrCharacterCountBitLength(version) {
  if (!version || version <= 9) return 9;
  if (version <= 26) return 11;
  return 13;
}

function hiddenPayloadByteOffset(version) {
  const visibleBits = 4 + qrCharacterCountBitLength(version) + alphanumericDataBitLength(VISIBLE_QR_TEXT);
  const afterTerminatorBits = visibleBits + 4;
  return Math.ceil(afterTerminatorBits / 8);
}

function framedPayloadFrom(bytes, lengthOffset) {
  const payloadOffset = lengthOffset + HIDDEN_PAYLOAD_LENGTH_BYTES;
  if (payloadOffset > bytes.length) return null;

  const payloadLength = (bytes[lengthOffset] << 8) | bytes[lengthOffset + 1];
  const payloadEnd = payloadOffset + payloadLength;
  if (payloadEnd > bytes.length) return null;

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(payloadOffset, payloadEnd));
  } catch {
    return null;
  }
}

export function extractHiddenQRedPayload(binaryData, version) {
  const bytes = bytesFrom(binaryData);
  const payloadOffset = hiddenPayloadByteOffset(version);
  if (payloadOffset >= bytes.length) return null;
  return framedPayloadFrom(bytes, payloadOffset);
}

export function qredTextFromScanResult(scanResult) {
  if (!scanResult || typeof scanResult === "string") return scanResult || "";
  const visibleText = scanResult.data || "";
  const hiddenPayload = extractHiddenQRedPayload(scanResult.binaryData, scanResult.version);
  if (visibleText === VISIBLE_QR_TEXT || visibleText.includes("QRED1") || visibleText.includes("qred.org")) {
    return hiddenPayload || visibleText;
  }
  return visibleText;
}

export function qredTextFromPhotoScanResult(imageData, width, height, scanResult) {
  const visibleText = qredTextFromScanResult(scanResult);
  if (!imageData || !width || !height) return visibleText;
  return extractHiddenQRedPayloadFromImage(imageData, width, height, scanResult) || visibleText;
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function decodeBrotli(value) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("Brotli decoding is not available in this browser");
  }
  const stream = new Blob([decodeBase64Url(value)]).stream().pipeThrough(new DecompressionStream("br"));
  const buffer = await new Response(stream).arrayBuffer();
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function sealFragment(sealString) {
  const hashIndex = sealString.indexOf("#");
  return hashIndex >= 0 ? sealString.slice(hashIndex + 1) : sealString;
}

function decodePlaintextFragment(fragment) {
  if (!fragment.startsWith("QRED1?")) return null;
  const params = new URLSearchParams(fragment.slice("QRED1?".length));
  const chunkNumber = Number.parseInt(params.get("i") || "", 10);
  const totalChunks = Number.parseInt(params.get("n") || "", 10);
  const documentId = params.get("doc") || "";
  if (!documentId || !Number.isInteger(chunkNumber) || !Number.isInteger(totalChunks)) return null;

  return {
    format_id: "QRED1",
    document_id: documentId,
    chunk_number: chunkNumber,
    total_chunks: totalChunks,
    data: params.get("txt") || "",
    recipe: params.get("rc") || "plaintext",
    algorithm: params.get("alg") || "Ed25519",
    issuer: params.get("iss") || "",
    key_id: params.get("kid") || "",
    signature: params.get("sig") || "",
    timestamp: params.get("ts") || "",
    version: params.get("v") || "1",
  };
}

export function decodeSeal(sealString) {
  const fragment = sealFragment(sealString);
  const plaintext = decodePlaintextFragment(fragment);
  if (plaintext) return plaintext;

  return null;
}

export async function verifyQRedSeals(seals, publicKey) {
  const context = { chunks: {}, document_id: "", total_chunks: 0, errors: [], plaintext: false, metadata: {} };

  for (const seal of seals) {
    const decoded = decodeSeal(seal);
    if (!decoded) {
      context.errors.push(`Malformed seal: ${seal.slice(0, 50)}`);
      continue;
    }

    if (context.document_id && decoded.document_id !== context.document_id) {
      return {
        status: "INVALID",
        document_id: context.document_id,
        error_message: "Mixed document IDs",
      };
    }

    if (!context.document_id) context.document_id = decoded.document_id;
    context.total_chunks = decoded.total_chunks;
    context.chunks[decoded.chunk_number] = decoded.data;
    if (decoded.recipe !== undefined) {
      context.plaintext = true;
      context.metadata = { ...context.metadata, recipe: decoded.recipe };
    }
    if (decoded.recipe !== undefined || decoded.algorithm) {
      context.metadata = { ...context.metadata, ...Object.fromEntries(
        Object.entries({
          algorithm: decoded.algorithm,
          issuer: decoded.issuer,
          key_id: decoded.key_id,
          signature: decoded.signature,
          timestamp: decoded.timestamp,
          version: decoded.version,
        }).filter(([, value]) => value)
      ) };
    }
  }

  const chunkNumbers = Object.keys(context.chunks).map(Number);
  if (chunkNumbers.length === 0) {
    return { status: "ERROR", error_message: "No valid chunks found" };
  }

  const missing = [];
  for (let i = 0; i < context.total_chunks; i += 1) {
    if (!(i in context.chunks)) missing.push(i);
  }
  if (missing.length > 0) {
    return {
      status: "INCOMPLETE",
      document_id: context.document_id,
      error_message: `Missing chunks: [${missing.join(", ")}]`,
    };
  }

  let payload;
  try {
    const rawData = Array.from({ length: context.total_chunks }, (_, i) => context.chunks[i]).join("");
    if (context.plaintext) {
      payload = {
        algorithm: context.metadata.algorithm || "Ed25519",
        content: rawData,
        document_id: context.document_id,
        issuer: context.metadata.issuer || "",
        key_id: context.metadata.key_id || "",
        signature: context.metadata.signature || "",
        timestamp: context.metadata.timestamp || "",
        version: context.metadata.version || "1",
        recipe: context.metadata.recipe || "plaintext",
      };
    } else {
      return { status: "ERROR", error_message: "Unsupported seal format" };
    }
  } catch (error) {
    return { status: "ERROR", error_message: `Payload decoding failed: ${error.message}` };
  }

  const content = payload.content || "";
  const recipe = payload.recipe || "plaintext";
  const recipeDecoders = {
    b45: decodeB45ish,
    base45ish: decodeB45ish,
    recipe1: decodeB45ish,
    simple_english: decodeB45ish,
    brotli: decodeBrotli,
  };
  let restoredContent;
  try {
    restoredContent = await (recipeDecoders[recipe] || ((value) => value))(content);
  } catch (error) {
    return { status: "ERROR", error_message: `Recipe decoding failed: ${error.message}` };
  }
  const signature = payload.signature || "";
  const issuer = payload.issuer || "";
  const documentId = payload.document_id || "";
  const timestamp = payload.timestamp || "";
  const keyId = payload.key_id || "";

  if (!publicKey) {
    return {
      status: "UNVERIFIED",
      document_id: documentId,
      issuer,
      timestamp,
      content: restoredContent,
      recipe,
      key_id: keyId,
      error_message: "No trusted public key available for signature verification",
    };
  }

  let isValid;
  try {
    const message = new TextEncoder().encode(restoredContent);
    isValid = await verifyEd25519(decodeBase64Url(signature), message, decodeBase64Url(publicKey));
  } catch {
    isValid = false;
  }

  if (isValid) {
    return {
      status: "VALID",
      issuer,
      document_id: documentId,
      timestamp,
      content: restoredContent,
      recipe,
      key_id: keyId,
    };
  }

  return {
    status: "INVALID",
    issuer,
    document_id: documentId,
    error_message: "Digital signature verification failed",
    content: restoredContent,
    recipe,
    key_id: keyId,
  };
}

export function tokenizeDocumentText(text) {
  return (text || "").match(/\S+|\s+/g) || [];
}

function comparableToken(token) {
  return token.trim().toLocaleLowerCase().replace(/^\p{P}+|\p{P}+$/gu, "");
}

export function compareWordSequences(qrWords, pageWords) {
  const qrItems = qrWords.map((word, index) => ({ word, index, key: comparableToken(word) })).filter((item) => item.key);
  const pageItems = pageWords.map((word, index) => ({ word, index, key: comparableToken(word) })).filter((item) => item.key);

  const table = Array.from({ length: qrItems.length + 1 }, () => Array(pageItems.length + 1).fill(0));
  for (let i = qrItems.length - 1; i >= 0; i -= 1) {
    for (let j = pageItems.length - 1; j >= 0; j -= 1) {
      table[i][j] = qrItems[i].key === pageItems[j].key
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const matchedQr = new Set();
  const matchedPage = new Set();
  let i = 0;
  let j = 0;
  while (i < qrItems.length && j < pageItems.length) {
    if (qrItems[i].key === pageItems[j].key) {
      matchedQr.add(qrItems[i].index);
      matchedPage.add(pageItems[j].index);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return {
    matchedQr,
    matchedPage,
    matchedWords: matchedQr.size,
    missingWords: qrItems.length - matchedQr.size,
    extraWords: pageItems.length - matchedPage.size,
    missingQrWords: qrItems.filter((item) => !matchedQr.has(item.index)).map((item) => item.word),
  };
}

export function compareDocumentText(qrText, pageText) {
  const qrTokens = tokenizeDocumentText(qrText);
  const pageTokens = tokenizeDocumentText(pageText);
  const comparison = compareWordSequences(qrTokens, pageTokens);

  return {
    qrTokens: qrTokens.map((token, index) => ({ token, status: comparableToken(token) ? (comparison.matchedQr.has(index) ? "matched" : "missing") : "space" })),
    pageTokens: pageTokens.map((token, index) => ({ token, status: comparableToken(token) ? (comparison.matchedPage.has(index) ? "matched" : "extra") : "space" })),
    matchedWords: comparison.matchedWords,
    missingWords: comparison.missingWords,
    extraWords: comparison.extraWords,
  };
}

function bitAt(matrix, row, col) {
  return matrix[row]?.[col] ? 1 : 0;
}

function formatBitPositions(size) {
  const first = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  const second = [[size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8], [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]];
  return [first, second];
}

function readFormatBits(matrix) {
  const [first, second] = formatBitPositions(matrix.length);
  return [first, second].map((positions) => positions.reduce((value, [row, col]) => (value << 1) | bitAt(matrix, row, col), 0));
}

function formatHammingDistance(a, b) {
  let diff = a ^ b;
  let count = 0;
  while (diff) {
    count += 1;
    diff &= diff - 1;
  }
  return count;
}

function qrMaskBit(mask, row, col) {
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

function decodeFormatInfo(matrix) {
  const formats = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0, 0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976, 0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b, 0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed];
  let best = { distance: Infinity, index: -1 };
  for (const read of readFormatBits(matrix)) {
    for (let index = 0; index < formats.length; index += 1) {
      const distance = formatHammingDistance(read, formats[index]);
      if (distance < best.distance) best = { distance, index };
    }
  }
  if (best.distance > 3) return null;
  return {
    ecLevelBits: Math.floor(best.index / 8),
    maskPattern: best.index % 8,
  };
}

function alignmentCenters(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil(((version * 4 + 4) / (count * 2 - 2))) * 2;
  const centers = [6];
  for (let pos = 17 + 4 * version - 7; centers.length < count; pos -= step) centers.splice(1, 0, pos);
  return centers;
}

function functionMask(size, version) {
  const mask = Array.from({ length: size }, () => Array(size).fill(false));
  const mark = (r0, c0, h, w) => {
    for (let r = Math.max(0, r0); r < Math.min(size, r0 + h); r += 1) for (let c = Math.max(0, c0); c < Math.min(size, c0 + w); c += 1) mask[r][c] = true;
  };
  mark(0, 0, 9, 9); mark(0, size - 8, 9, 8); mark(size - 8, 0, 8, 9);
  mark(6, 0, 1, size); mark(0, 6, size, 1);
  for (const r of alignmentCenters(version)) for (const c of alignmentCenters(version)) {
    if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
    mark(r - 2, c - 2, 5, 5);
  }
  if (version >= 7) { mark(0, size - 11, 6, 3); mark(size - 11, 0, 3, 6); }
  return mask;
}

function codewordsFromMatrix(matrix, version) {
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


const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085, 1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706];
const EC_BLOCKS_BY_LEVEL = [
  [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [0, 1, 1, 2, 4, 4, 4, 5, 6, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77],
  [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65],
];
const EC_CODEWORDS_BY_LEVEL = [
  [0, 10, 16, 26, 36, 48, 64, 72, 88, 110, 130, 150, 176, 198, 216, 240, 280, 308, 338, 364, 416, 442, 476, 504, 560, 588, 644, 700, 728, 784, 812, 868, 924, 980, 1036, 1064, 1120, 1204, 1260, 1316, 1372],
  [0, 7, 10, 15, 20, 26, 36, 40, 48, 60, 72, 80, 96, 104, 120, 132, 144, 168, 180, 196, 224, 224, 252, 270, 300, 312, 336, 360, 390, 420, 450, 480, 510, 540, 570, 570, 600, 630, 660, 720, 750],
  [0, 17, 28, 44, 64, 88, 112, 130, 156, 192, 224, 264, 308, 352, 384, 432, 480, 532, 588, 650, 700, 750, 816, 900, 960, 1050, 1110, 1200, 1260, 1350, 1440, 1530, 1620, 1710, 1800, 1890, 1980, 2100, 2220, 2310, 2430],
  [0, 13, 22, 36, 52, 72, 96, 108, 132, 160, 192, 224, 260, 288, 320, 360, 408, 448, 504, 546, 600, 644, 690, 750, 810, 870, 952, 1020, 1050, 1140, 1200, 1290, 1350, 1440, 1530, 1590, 1680, 1770, 1860, 1950, 2040],
];

function deinterleaveDataCodewords(interleaved, version, ecLevelBits = 0) {
  const totalCodewords = TOTAL_CODEWORDS[version];
  const ecTotalCodewords = EC_CODEWORDS_BY_LEVEL[ecLevelBits]?.[version];
  const ecTotalBlocks = EC_BLOCKS_BY_LEVEL[ecLevelBits]?.[version];
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

function lerp(a, b, t) { return a + ((b - a) * t); }

function sampleLuminance(imageData, width, height, x, y) {
  const clampedX = Math.max(0, Math.min(width - 1, Math.round(x)));
  const clampedY = Math.max(0, Math.min(height - 1, Math.round(y)));
  const index = ((clampedY * width) + clampedX) * 4;
  return (imageData[index] + imageData[index + 1] + imageData[index + 2]) / 3;
}

function moduleCenter(location, row, col, size, rowOffset = 0.5, colOffset = 0.5) {
  const v = (row + rowOffset) / size;
  const u = (col + colOffset) / size;
  const leftX = lerp(location.topLeftCorner.x, location.bottomLeftCorner.x, v);
  const leftY = lerp(location.topLeftCorner.y, location.bottomLeftCorner.y, v);
  const rightX = lerp(location.topRightCorner.x, location.bottomRightCorner.x, v);
  const rightY = lerp(location.topRightCorner.y, location.bottomRightCorner.y, v);
  return { x: lerp(leftX, rightX, u), y: lerp(leftY, rightY, u) };
}

function sampledModuleLuminance(imageData, width, height, location, row, col, size, rowOffset, colOffset) {
  const center = moduleCenter(location, row, col, size, rowOffset, colOffset);
  const samples = [
    sampleLuminance(imageData, width, height, center.x, center.y),
    sampleLuminance(imageData, width, height, center.x - 0.35, center.y),
    sampleLuminance(imageData, width, height, center.x + 0.35, center.y),
    sampleLuminance(imageData, width, height, center.x, center.y - 0.35),
    sampleLuminance(imageData, width, height, center.x, center.y + 0.35),
  ].sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

function adaptiveThreshold(luminances) {
  const sorted = [...luminances].sort((a, b) => a - b);
  if (sorted.length === 0) return 128;
  const darkest = sorted[Math.floor(sorted.length * 0.1)];
  const lightest = sorted[Math.floor(sorted.length * 0.9)];
  return (darkest + lightest) / 2;
}

function sampleQrMatrix(imageData, width, height, location, version, options = {}) {
  const size = 17 + (4 * version);
  const rowOffset = options.rowOffset ?? 0.5;
  const colOffset = options.colOffset ?? 0.5;
  const luminances = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      luminances.push(sampledModuleLuminance(imageData, width, height, location, row, col, size, rowOffset, colOffset));
    }
  }
  const threshold = options.threshold ?? adaptiveThreshold(luminances);
  const matrix = [];
  let index = 0;
  for (let row = 0; row < size; row += 1) {
    const line = [];
    for (let col = 0; col < size; col += 1) {
      line.push(luminances[index] < threshold);
      index += 1;
    }
    matrix.push(line);
  }
  return matrix;
}

export function extractHiddenQRedPayloadFromImage(imageData, width, height, scanResult) {
  if (!scanResult?.location || !scanResult.version) return null;
  // quirc-style hidden payload recovery reads the raw module/codeword stream after
  // normal QR decoding locates the symbol. Try a few center-biased grids and
  // thresholds so photographed seals still yield hidden bytes when focus,
  // perspective correction, or exposure are slightly off.
  const sampleOptions = [
    {},
    { threshold: 128 },
    { rowOffset: 0.45, colOffset: 0.5 },
    { rowOffset: 0.55, colOffset: 0.5 },
    { rowOffset: 0.5, colOffset: 0.45 },
    { rowOffset: 0.5, colOffset: 0.55 },
  ];
  for (const options of sampleOptions) {
    const matrix = sampleQrMatrix(imageData, width, height, scanResult.location, scanResult.version, options);
    const { codewords, ecLevelBits } = codewordsFromMatrix(matrix, scanResult.version);
    const payload = extractHiddenQRedPayload(deinterleaveDataCodewords(codewords, scanResult.version, ecLevelBits), scanResult.version);
    if (payload) return payload;
  }
  return null;
}
