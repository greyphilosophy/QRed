import QRCode from "qrcode";
import Utils from "qrcode/lib/core/utils";
import ECCode from "qrcode/lib/core/error-correction-code";
import ECLevel from "qrcode/lib/core/error-correction-level";
import BitBuffer from "qrcode/lib/core/bit-buffer";
import ReedSolomonEncoder from "qrcode/lib/core/reed-solomon-encoder";
import Mode from "qrcode/lib/core/mode";
import AlphanumericData from "qrcode/lib/core/alphanumeric-data";
import MaskPattern from "qrcode/lib/core/mask-pattern";
import PngRenderer from "qrcode/lib/renderer/png";
import { VISIBLE_QR_TEXT } from "./qredVerifier.js";

const HIDDEN_PAYLOAD_LENGTH_BYTES = 2;
const DEFAULT_QR_OPTIONS = { errorCorrectionLevel: "M", margin: 2, width: 360 };

function characterCountBitLength(version) {
  return Mode.getCharCountIndicator(Mode.ALPHANUMERIC, version);
}

export function qredVisibleBitsLength(version) {
  return 4 + characterCountBitLength(version) + AlphanumericData.getBitsLength(VISIBLE_QR_TEXT.length);
}

export function qredHiddenPayloadByteOffset(version) {
  return Math.ceil((qredVisibleBitsLength(version) + 4) / 8);
}

function dataCapacityBytes(version, errorCorrectionLevel) {
  return Utils.getSymbolTotalCodewords(version) - ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
}

function chooseVersion(payloadBytes, errorCorrectionLevel) {
  for (let version = 1; version <= 40; version += 1) {
    const required = qredHiddenPayloadByteOffset(version) + HIDDEN_PAYLOAD_LENGTH_BYTES + payloadBytes.length;
    if (required <= dataCapacityBytes(version, errorCorrectionLevel)) return version;
  }
  throw new Error("The amount of QRed payload data is too big to be stored in a QR Code");
}

export function createCodewords(bitBuffer, version, errorCorrectionLevel) {
  const totalCodewords = Utils.getSymbolTotalCodewords(version);
  const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
  const dataTotalCodewords = totalCodewords - ecTotalCodewords;
  const ecTotalBlocks = ECCode.getBlocksCount(version, errorCorrectionLevel);
  const blocksInGroup2 = totalCodewords % ecTotalBlocks;
  const blocksInGroup1 = ecTotalBlocks - blocksInGroup2;
  const totalCodewordsInGroup1 = Math.floor(totalCodewords / ecTotalBlocks);
  const dataCodewordsInGroup1 = Math.floor(dataTotalCodewords / ecTotalBlocks);
  const dataCodewordsInGroup2 = dataCodewordsInGroup1 + 1;
  const ecCount = totalCodewordsInGroup1 - dataCodewordsInGroup1;
  const rs = new ReedSolomonEncoder(ecCount);
  let offset = 0;
  const dcData = [];
  const ecData = [];
  let maxDataSize = 0;
  const buffer = new Uint8Array(bitBuffer.buffer);
  for (let block = 0; block < ecTotalBlocks; block += 1) {
    const dataSize = block < blocksInGroup1 ? dataCodewordsInGroup1 : dataCodewordsInGroup2;
    dcData[block] = buffer.slice(offset, offset + dataSize);
    ecData[block] = rs.encode(dcData[block]);
    offset += dataSize;
    maxDataSize = Math.max(maxDataSize, dataSize);
  }
  const data = new Uint8Array(totalCodewords);
  let index = 0;
  for (let i = 0; i < maxDataSize; i += 1) {
    for (let block = 0; block < ecTotalBlocks; block += 1) {
      if (i < dcData[block].length) data[index++] = dcData[block][i];
    }
  }
  for (let i = 0; i < ecCount; i += 1) {
    for (let block = 0; block < ecTotalBlocks; block += 1) data[index++] = ecData[block][i];
  }
  return data;
}

function setupData(matrix, data) {
  const size = matrix.size;
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    while (true) {
      for (let c = 0; c < 2; c += 1) {
        if (!matrix.isReserved(row, col - c)) {
          const dark = byteIndex < data.length && (((data[byteIndex] >>> bitIndex) & 1) === 1);
          matrix.set(row, col - c, dark);
          bitIndex -= 1;
          if (bitIndex === -1) {
            byteIndex += 1;
            bitIndex = 7;
          }
        }
      }
      row += inc;
      if (row < 0 || size <= row) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
}

export function createQRedQrData(value) {
  const payloadBytes = new TextEncoder().encode(value);
  if (payloadBytes.length > 0xffff) throw new Error("QRed payload is too large to frame");
  const errorCorrectionLevel = ECLevel.M;
  const version = chooseVersion(payloadBytes, errorCorrectionLevel);
  const buffer = new BitBuffer();
  const visible = new AlphanumericData(VISIBLE_QR_TEXT);
  buffer.put(visible.mode.bit, 4);
  buffer.put(visible.getLength(), characterCountBitLength(version));
  visible.write(buffer);
  buffer.put(0, 4);
  while (buffer.getLengthInBits() % 8 !== 0) buffer.putBit(0);
  buffer.put(payloadBytes.length >>> 8, 8);
  buffer.put(payloadBytes.length & 0xff, 8);
  for (const byte of payloadBytes) buffer.put(byte, 8);
  const capacityBits = dataCapacityBytes(version, errorCorrectionLevel) * 8;
  for (let i = 0; buffer.getLengthInBits() < capacityBits; i += 1) buffer.put(i % 2 ? 0x11 : 0xec, 8);

  return { version, bytes: new Uint8Array(buffer.buffer), codewords: createCodewords(buffer, version, errorCorrectionLevel) };
}

export function createQRedQrSymbol(value) {
  const { version, codewords } = createQRedQrData(value);
  const visible = new AlphanumericData(VISIBLE_QR_TEXT);
  const qr = QRCode.create(VISIBLE_QR_TEXT, { errorCorrectionLevel: "M", version });
  MaskPattern.applyMask(qr.maskPattern, qr.modules);
  setupData(qr.modules, codewords);
  MaskPattern.applyMask(qr.maskPattern, qr.modules);
  qr.segments = [visible];
  return qr;
}

function renderModulesToDataUrl(qr, options = DEFAULT_QR_OPTIONS) {
  if (typeof document === "undefined") return null;
  const margin = options.margin ?? 2;
  const width = options.width ?? 360;
  const modules = qr.modules;
  const tile = width / (modules.size + (margin * 2));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = width;
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, width);
  context.fillStyle = "#000";
  for (let row = 0; row < modules.size; row += 1) {
    for (let col = 0; col < modules.size; col += 1) {
      if (modules.get(row, col)) context.fillRect((col + margin) * tile, (row + margin) * tile, Math.ceil(tile), Math.ceil(tile));
    }
  }
  return canvas.toDataURL("image/png");
}

async function renderModulesToPngBytes(qr, options = DEFAULT_QR_OPTIONS) {
  const dataUrl = renderModulesToDataUrl(qr, options);
  if (dataUrl) return dataUrl;
  const buffer = await new Promise((resolve, reject) => {
    PngRenderer.renderToBuffer(qr, options, (error, output) => (error ? reject(error) : resolve(output)));
  });
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

export async function qredQrPngDataUrl(value, options = DEFAULT_QR_OPTIONS) {
  return renderModulesToPngBytes(createQRedQrSymbol(value), options);
}
