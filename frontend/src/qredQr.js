import QRCode from "qrcode";
import Utils from "qrcode/lib/core/utils";
import ECCode from "qrcode/lib/core/error-correction-code";
import ECLevel from "qrcode/lib/core/error-correction-level";
import BitBuffer from "qrcode/lib/core/bit-buffer";
import ReedSolomonEncoder from "qrcode/lib/core/reed-solomon-encoder";
import Mode from "qrcode/lib/core/mode";
import ByteData from "qrcode/lib/core/byte-data";
import { qrPayloadBytes } from "./sealFormat.js";

const MIN_MODULE_PIXELS = 4;
const DEFAULT_QR_OPTIONS = { errorCorrectionLevel: "auto", margin: 4, width: 360 };
const ERROR_CORRECTION_LEVELS_DESC = ["H", "Q", "M", "L"];

export function qredByteHeaderBits(version) {
  return 4 + Mode.getCharCountIndicator(Mode.BYTE, version);
}

function dataCapacityBytes(version, errorCorrectionLevel) {
  return Utils.getSymbolTotalCodewords(version) - ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
}

export function qredPayloadCapacity(version = 40, errorCorrectionLevel = ECLevel.L) {
  return Math.floor((dataCapacityBytes(version, errorCorrectionLevel) * 8 - qredByteHeaderBits(version)) / 8);
}

function resolveErrorCorrectionLevel(value) {
  if (!value || value === "auto") {
    return null;
  }
  return ECLevel.from(value, ECLevel.M);
}

function chooseQrShape(payloadBytes, requestedErrorCorrectionLevel) {
  const fixedErrorCorrectionLevel = resolveErrorCorrectionLevel(requestedErrorCorrectionLevel);
  const levels = fixedErrorCorrectionLevel
    ? [fixedErrorCorrectionLevel]
    : ERROR_CORRECTION_LEVELS_DESC.map((level) => ECLevel.from(level, ECLevel.M));

  // Fewer modules make each printed square larger at the same physical size.
  // Spend spare capacity on error correction without enlarging the grid.
  for (let version = 1; version <= 40; version += 1) {
    for (const errorCorrectionLevel of levels) {
      if (payloadBytes.length <= qredPayloadCapacity(version, errorCorrectionLevel)) return { version, errorCorrectionLevel };
    }
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

export function createQRedQrData(value, options = DEFAULT_QR_OPTIONS) {
  const payloadBytes = qrPayloadBytes(value);
  const { version, errorCorrectionLevel } = chooseQrShape(payloadBytes, options.errorCorrectionLevel);
  const buffer = new BitBuffer();
  const segment = new ByteData(payloadBytes);
  buffer.put(segment.mode.bit, 4);
  buffer.put(segment.getLength(), Mode.getCharCountIndicator(Mode.BYTE, version));
  segment.write(buffer);
  const capacityBits = dataCapacityBytes(version, errorCorrectionLevel) * 8;
  buffer.put(0, Math.min(4, capacityBits - buffer.getLengthInBits()));
  while (buffer.getLengthInBits() % 8 !== 0) buffer.putBit(0);
  for (let i = 0; buffer.getLengthInBits() < capacityBits; i += 1) buffer.put(i % 2 ? 0x11 : 0xec, 8);

  return { version, errorCorrectionLevel, payloadBytes, bytes: new Uint8Array(buffer.buffer), codewords: createCodewords(buffer, version, errorCorrectionLevel) };
}

export function createQRedQrSymbol(value, options = DEFAULT_QR_OPTIONS) {
  const payloadBytes = qrPayloadBytes(value);
  const { version, errorCorrectionLevel } = chooseQrShape(payloadBytes, options.errorCorrectionLevel);
  return QRCode.create([{ data: payloadBytes, mode: "byte" }], { version, errorCorrectionLevel });
}

export function qredRasterPlan(moduleCount, options = DEFAULT_QR_OPTIONS) {
  const margin = options.margin ?? 2;
  const requestedWidth = options.width ?? 360;
  const modulesWithMargin = moduleCount + (margin * 2);
  const tile = Math.max(MIN_MODULE_PIXELS, Math.floor(requestedWidth / modulesWithMargin));
  return { margin, tile, width: modulesWithMargin * tile };
}

function renderModulesToDataUrl(qr, options = DEFAULT_QR_OPTIONS) {
  if (typeof document === "undefined") return null;
  const modules = qr.modules;
  const { margin, tile, width } = qredRasterPlan(modules.size, options);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = width;
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, width);
  context.fillStyle = "#000";
  for (let row = 0; row < modules.size; row += 1) {
    for (let col = 0; col < modules.size; col += 1) {
      if (modules.get(row, col)) context.fillRect((col + margin) * tile, (row + margin) * tile, tile, tile);
    }
  }
  return canvas.toDataURL("image/png");
}

async function renderModulesToPngBytes(qr, options = DEFAULT_QR_OPTIONS) {
  const dataUrl = renderModulesToDataUrl(qr, options);
  if (dataUrl) return dataUrl;
  const { default: PngRenderer } = await import("qrcode/lib/renderer/png");
  const plan = qredRasterPlan(qr.modules.size, options);
  const buffer = await new Promise((resolve, reject) => {
    PngRenderer.renderToBuffer(qr, { ...options, margin: plan.margin, width: plan.width, scale: plan.tile }, (error, output) => (error ? reject(error) : resolve(output)));
  });
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

export async function qredQrPngDataUrl(value, options = DEFAULT_QR_OPTIONS) {
  return renderModulesToPngBytes(createQRedQrSymbol(value, options), options);
}
