import { describe, expect, it } from "vitest";
import { createQRedQrSymbol, createQRedQrData } from "../qredQr.js";
import { encodeChunk, sealString } from "../sealFormat.js";
import { hiddenPayloadFromScanResult } from "./hiddenPayload.js";
import { readErasedQrMatrix, recoverErasedDataCodewords } from "./qrErasureRecovery.js";
import { codewordsFromMatrix } from "./qrLowLevel.js";

function fixture() {
  const payload = new Uint8Array(720);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 17 + (i >>> 2) * 37) & 255;
  // Use a correctly framed QRC3 transport chunk. Arbitrary bytes are not
  // a QRed seal and must be rejected by hidden-payload recovery.
  const seal = sealString(encodeChunk(new Uint8Array(32).fill(23), 0, 4, payload));
  const symbol = createQRedQrSymbol(seal, { errorCorrectionLevel: "L" });
  const size = symbol.modules.size;
  const bits = new Uint8Array(size * size);
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    bits[row * size + col] = Number(Boolean(symbol.modules.get(row, col)));
  }
  return { seal, symbol, size, bits, unknown: new Uint8Array(bits.length) };
}

function recoveredSeal(qr, bits, unknown) {
  const result = readErasedQrMatrix(bits, unknown, qr.symbol.version);
  return hiddenPayloadFromScanResult(result && {
    data: "QRED.ORG", correctedData: result.correctedData, version: qr.symbol.version,
  });
}

describe("QR Reed-Solomon erasure-aware recovery", () => {
  it("reads the original complete hidden payload without changing its signed wire format", () => {
    const qr = fixture();
    const data = createQRedQrData(qr.seal, { errorCorrectionLevel: "L" });
    const matrix = Array.from({ length: qr.size }, (_, row) =>
      Array.from({ length: qr.size }, (_, col) => Boolean(qr.bits[row * qr.size + col])));
    const extracted = codewordsFromMatrix(matrix, qr.symbol.version);
    const difference = extracted.codewords.reduce((sum, byte, i) => sum + Number(byte !== data.codewords[i]), 0);
    const corrected = recoverErasedDataCodewords(data.codewords, data.version, 1);
    console.info("WM RS diagnostics", { version: data.version, ecLevelBits: extracted.ecLevelBits,
      extractedLength: extracted.codewords.length, codewordCount: data.codewords.length,
      difference, rawDirectDecodes: corrected !== null,
      extractedHead: Array.from(extracted.codewords.slice(0, 12)),
      encodedHead: Array.from(data.codewords.slice(0, 12)) });
    expect(Array.from(corrected ?? [])).toEqual(Array.from(data.bytes));
    const directPayload = hiddenPayloadFromScanResult({ data: "QRED.ORG", version: data.version,
      correctedData: corrected });
    const matrixResult = readErasedQrMatrix(qr.bits, qr.unknown, qr.symbol.version);
    const matrixPayload = hiddenPayloadFromScanResult(matrixResult && { data: "QRED.ORG",
      version: data.version, correctedData: matrixResult.correctedData });
    console.info("WM RS extraction", { directMatches: directPayload === qr.seal,
      directPrefix: directPayload?.slice(0, 30), matrixPresent: Boolean(matrixResult),
      matrixCorrectedLength: matrixResult?.correctedData.length,
      matrixMatches: matrixPayload === qr.seal });
    expect(recoveredSeal(qr, qr.bits, qr.unknown)).toBe(qr.seal);
  });

  it("reconstructs codeword erasures when opaque text covers known module positions", () => {
    const qr = fixture();
    const bits = qr.bits.slice(), unknown = qr.unknown.slice();
    for (let row = 30; row < 32; row++) for (let col = 18; col < qr.size - 18; col++) {
      const index = row * qr.size + col;
      bits[index] = 0;
      unknown[index] = 1;
    }
    expect(recoveredSeal(qr, bits, unknown)).toBe(qr.seal);
  });

  it("fails closed when too many codewords are missing instead of fabricating data", () => {
    const qr = fixture();
    const bits = qr.bits.slice(), unknown = qr.unknown.slice();
    for (let row = 10; row < qr.size - 10; row++) for (let col = 10; col < qr.size - 10; col++) {
      const index = row * qr.size + col;
      bits[index] = 0;
      unknown[index] = 1;
    }
    expect(recoveredSeal(qr, bits, unknown)).toBeNull();
  });
});
