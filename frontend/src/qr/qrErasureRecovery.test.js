import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { createQRedQrSymbol, createQRedQrData } from "../qredQr.js";
import { encodeChunk, sealString } from "../sealFormat.js";
import { hiddenPayloadFromScanResult } from "./hiddenPayload.js";
import { readErasedQrMatrix, recoverBitErasedDataCodewords, recoverErasedDataCodewords } from "./qrErasureRecovery.js";
import { codewordsFromMatrix, EC_BLOCKS_BY_LEVEL } from "./qrLowLevel.js";

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
    expect(difference).toBe(0);
    expect(extracted.ecLevelBits).toBe(1);
    expect(Array.from(corrected ?? [])).toEqual(Array.from(data.bytes));
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

  it("corrects unknown byte errors alongside known foreground erasures", () => {
    const qr = fixture();
    const bits = qr.bits.slice(), unknown = qr.unknown.slice();
    for (let row = 30; row < 32; row++) for (let col = 18; col < qr.size - 18; col++) {
      const index = row * qr.size + col;
      bits[index] = 0;
      unknown[index] = 1;
    }
    let corrupted = false;
    for (let row = 40; row < qr.size - 15 && !corrupted; row++) {
      for (let col = 28; col < qr.size - 15; col++) {
        if (qr.symbol.modules.isReserved(row, col)) continue;
        bits[row * qr.size + col] ^= 1; // Unmarked wrong codeword.
        corrupted = true;
        break;
      }
    }
    expect(corrupted).toBe(true);
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

  it("locates one misread known bit alongside many independently erased bits", () => {
    const qr = fixture(), data = createQRedQrData(qr.seal, { errorCorrectionLevel: "L" });
    const masks = Uint8Array.from(data.codewords, (_, i) => 1 << ((i * 5 + Math.floor(i / 7)) % 8));
    const damaged = Uint8Array.from(data.codewords, (byte, i) => byte ^ masks[i]);
    // Every byte has a missing bit, so ordinary byte correction is exhausted.
    // One extra flipped bit lies outside the observed erasure mask.
    damaged[0] ^= masks[0] === 128 ? 1 : masks[0] << 1;
    expect(recoverBitErasedDataCodewords(damaged, data.version, 1, masks)).toBeNull();
    const corrected = recoverBitErasedDataCodewords(damaged, data.version, 1, masks,
      { allowSingleBitError: true });
    expect(Array.from(corrected ?? [])).toEqual(Array.from(data.bytes));
  });

  it("combines bit-erasure and ordinary byte correction across different parity blocks", () => {
    // Version 7/L has two equal blocks. Even/odd interleaved bytes identify
    // the blocks throughout both data and parity, independently of recovery.
    const symbol = QRCode.create("Independent parity-block correction", { version: 7, errorCorrectionLevel: "L" });
    const matrix = Array.from({ length: symbol.modules.size }, (_, row) =>
      Array.from({ length: symbol.modules.size }, (_, col) => Boolean(symbol.modules.get(row, col))));
    const { codewords } = codewordsFromMatrix(matrix, 7);
    const expected = recoverErasedDataCodewords(codewords, 7, 1);
    const masks = new Uint8Array(codewords.length), damaged = codewords.slice();
    for (let i = 0; i < codewords.length; i += 2) {
      masks[i] = 1 << ((i * 5 + Math.floor(i / 7)) % 8);
      damaged[i] ^= masks[i];
    }
    damaged[1] ^= 0x53; damaged[3] ^= 0x91;
    expect(recoverErasedDataCodewords(damaged, 7, 1)).toBeNull();
    expect(recoverBitErasedDataCodewords(damaged, 7, 1, masks)).toBeNull();
    const corrected = recoverBitErasedDataCodewords(damaged, 7, 1, masks,
      { allowSingleBitError: true });
    expect(Array.from(corrected ?? [])).toEqual(Array.from(expected));
  });

  it("rejects multiple unmarked bit errors when no unique supported correction exists", () => {
    const qr = fixture(), data = createQRedQrData(qr.seal, { errorCorrectionLevel: "L" });
    const masks = Uint8Array.from(data.codewords, (_, i) => 1 << ((i * 5 + Math.floor(i / 7)) % 8));
    const damaged = Uint8Array.from(data.codewords, (byte, i) => byte ^ masks[i]);
    // The first two data bytes of the same parity block, after interleave.
    for (const index of [0, EC_BLOCKS_BY_LEVEL[1][data.version]]) {
      damaged[index] ^= masks[index] === 128 ? 1 : masks[index] << 1;
    }
    expect(recoverBitErasedDataCodewords(damaged, data.version, 1, masks,
      { allowSingleBitError: true })).toBeNull();
  });

  it("does not substitute guessed byte erasures when the measured grid has no usable data", () => {
    const qr = fixture(), bits = qr.bits.slice();
    for (let row = 0; row < qr.size; row++) for (let col = 0; col < qr.size; col++) {
      if (!qr.symbol.modules.isReserved(row, col) && (row * 31 + col * 11) % 7 < 3)
        bits[row * qr.size + col] ^= 1;
    }
    const unknown = new Uint8Array(bits.length).fill(1);
    expect(readErasedQrMatrix(bits, unknown, qr.symbol.version, null,
      { allowSingleBitError: true, allowRankedErasures: false })).toBeNull();
  });
});
