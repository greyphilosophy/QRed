import { describe, expect, it } from "vitest";
import { createQRedQrSymbol } from "../qredQr.js";
import { sealString } from "../sealFormat.js";
import { hiddenPayloadFromScanResult } from "./hiddenPayload.js";
import { readErasedQrMatrix } from "./qrErasureRecovery.js";

function fixture() {
  const payload = new Uint8Array(720);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 17 + (i >>> 2) * 37) & 255;
  const seal = sealString(payload);
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
