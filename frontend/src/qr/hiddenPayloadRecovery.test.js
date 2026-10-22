import { qrPayloadBytes, sealString } from "../sealFormat.js";
import ECCode from "qrcode/lib/core/error-correction-code.js";
import ECLevel from "qrcode/lib/core/error-correction-level.js";
import QRCode from "qrcode";
import { beforeAll, describe, expect, it } from "vitest";
import { createQRedQrSymbol, qredHiddenPayloadByteOffset, qredPayloadCapacity } from "../qredQr.js";
import { createQRedSeals } from "../qredSealer.js";
import { qredPayloadFromPhotoScanResult, verifyQRedSeals, VISIBLE_QR_TEXT } from "../qredVerifier.js";
import { scanQrImage } from "./scanQrImage.js";
import { extractHiddenQRedPayloadFromImage as analyzerPayload, qredTextFromPhotoScanResult as analyzerText } from "../testAnalyzer.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";
const content = "Camera recovery regression: invoice QA-1042. Approved total: $123.45.";
let seal;
let gzipSeal;
let zlibSeal;

beforeAll(async () => {
  const result = await createQRedSeals({ content, privateKey, publicKey,
    encodingStrategy: "plaintext" });
  [seal] = result.seals;
  [gzipSeal] = (await createQRedSeals({ content, privateKey, publicKey,
    encodingStrategy: "gzip" })).seals;
  [zlibSeal] = (await createQRedSeals({ content, privateKey, publicKey,
    encodingStrategy: "zlib" })).seals;
});

function damageCodewords(qr, indexes) {
  const targetBits = new Set(indexes.map(index => index * 8));
  let bitIndex = 0;
  let upward = true;
  for (let right = qr.modules.size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1;
    for (let vertical = 0; vertical < qr.modules.size; vertical += 1) {
      const row = upward ? qr.modules.size - 1 - vertical : vertical;
      for (const col of [right, right - 1]) {
        if (qr.modules.isReserved(row, col)) continue;
        if (targetBits.delete(bitIndex++)) {
          qr.modules.set(row, col, !qr.modules.get(row, col));
          if (!targetBits.size) return;
        }
      }
    }
    upward = !upward;
  }
  throw new Error("Damage target was not found in the QR matrix");
}

function damageHiddenLength(qr) {
  // Flip the high bit of the hidden length byte in the first RS block.
  // This is one correctable symbol error, but makes raw-pixel recovery fail.
  const blocks = ECCode.getBlocksCount(qr.version, qr.errorCorrectionLevel);
  damageCodewords(qr, [qredHiddenPayloadByteOffset(qr.version) * blocks]);
}

function render(qr, { inverted = false, mirrored = false } = {}) {
  const tile = 5;
  const margin = 4;
  const width = (qr.modules.size + margin * 2) * tile;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const row = Math.floor(y / tile) - margin;
      const col = Math.floor((mirrored ? width - 1 - x : x) / tile) - margin;
      const inside = row >= 0 && row < qr.modules.size && col >= 0 && col < qr.modules.size;
      const dark = inside && Boolean(qr.modules.get(row, col));
      const value = dark !== inverted ? 0 : 255;
      const index = (y * width + x) * 4;
      data.set([value, value, value, 255], index);
    }
  }
  return { data, width, height: width };
}

function recover(image) {
  const code = scanQrImage(image.data, image.width, image.height);
  expect(code?.data, "the public marker must still decode").toBe(VISIBLE_QR_TEXT);
  return { code, payload: qredPayloadFromPhotoScanResult(image.data, image.width, image.height, code) };
}

describe("error-corrected hidden QR data", () => {
  it.each(["L", "M", "Q", "H"])("recovers signed version 23 seals with correction %s", async level => {
    // jsQR 1.4.0's version-23 table placed alignment patterns at 74 instead
    // of 78. Synthetic data keeps the reported private QR out of the tests.
    const overhead = qrPayloadBytes(seal).length - new TextEncoder().encode(content).length;
    const length = qredPayloadCapacity(22, ECLevel[level]) + 1 - overhead;
    const sample = "Synthetic-v23-alignment-regression.";
    const text = sample.repeat(Math.ceil(length / sample.length)).slice(0, length);
    const [original] = (await createQRedSeals({ content: text, privateKey, publicKey,
      encodingStrategy: "plaintext" })).seals;
    const qr = createQRedQrSymbol(original, { errorCorrectionLevel: level });
    expect(qr.version).toBe(23);
    for (const damaged of [false, true]) {
      if (damaged) damageHiddenLength(qr);
      const { code, payload } = recover(render(qr));
      expect(code.version).toBe(23);
      expect(payload).toBe(original);
      await expect(verifyQRedSeals([payload], publicKey)).resolves.toMatchObject({ status: "VALID", content: text });
    }
  });

  it.each(["plaintext", "zlib", "gzip"].flatMap(encoding => ["L", "M", "Q", "H"].map(level => [encoding, level])))("recovers %s data after damage to its length field (%s)", async (encoding, level) => {
    const original = { plaintext: seal, zlib: zlibSeal, gzip: gzipSeal }[encoding];
    const qr = createQRedQrSymbol(original, { errorCorrectionLevel: level });
    damageHiddenLength(qr);
    const { code, payload } = recover(render(qr));
    // The patch must preserve the upstream public message API.
    expect(code.binaryData).toEqual(Array.from(new TextEncoder().encode(VISIBLE_QR_TEXT)));
    expect(payload).toBe(original);
    await expect(verifyQRedSeals([payload], publicKey)).resolves.toMatchObject({ status: "VALID", content });
  });

  it.each([
    { inverted: true },
    { mirrored: true },
    { inverted: true, mirrored: true },
  ])("recovers damaged data with camera orientation/contrast %j", async (options) => {
    const qr = createQRedQrSymbol(seal);
    damageHiddenLength(qr);
    const image = render(qr, options);
    const { code, payload } = recover(image);
    expect(payload).toBe(seal);
    expect(analyzerPayload(image.data, image.width, image.height, code)).toBe(seal);
    expect(analyzerText(image.data, image.width, image.height, code)).toBe(content);
    await expect(verifyQRedSeals([payload], publicKey)).resolves.toMatchObject({ status: "VALID", content });
  });

  it("preserves ordinary QR codes carrying a visible seal URL", async () => {
    const image = render(QRCode.create(seal));
    const code = scanQrImage(image.data, image.width, image.height);
    expect(code?.data).toBe(seal);
    const payload = qredPayloadFromPhotoScanResult(image.data, image.width, image.height, code);
    expect(payload).toBe(seal);
    await expect(verifyQRedSeals([payload], publicKey)).resolves.toMatchObject({ status: "VALID", content });
  });

  it("does not manufacture a hidden payload for a normal QRED.ORG code", () => {
    const { payload } = recover(render(QRCode.create(VISIBLE_QR_TEXT)));
    expect(payload).toBe(VISIBLE_QR_TEXT);
  });

  it("does not fall back to unchecked pixels when corrected framing is malformed", () => {
    const image = render(createQRedQrSymbol(seal));
    const { code } = recover(image);
    const malformed = { ...code, correctedData: new Uint8ClampedArray(4) };
    expect(qredPayloadFromPhotoScanResult(image.data, image.width, image.height, malformed)).toBe(VISIBLE_QR_TEXT);
    expect(analyzerPayload(image.data, image.width, image.height, malformed)).toBeNull();
  });

  it("still rejects a wrong verification key and an altered signed payload", async () => {
    const { payload } = recover(render(createQRedQrSymbol(seal)));
    await expect(verifyQRedSeals([payload], "Sz8MZnNyHPkt6J3hC_rcXEabv4rrQSgAH_krcitjlF8")).resolves.toMatchObject({ status: "INVALID" });
    const changed = qrPayloadBytes(seal);
    changed[changed.length - 1] ^= 1;
    const altered = sealString(changed);
    const qr = createQRedQrSymbol(altered);
    damageHiddenLength(qr);
    const recovered = recover(render(qr)).payload;
    expect(recovered).toBe(altered);
    await expect(verifyQRedSeals([recovered], publicKey)).resolves.toMatchObject({ status: "INVALID" });
  });

  it("rejects a QR damaged beyond its correction capacity", () => {
    const qr = createQRedQrSymbol("IMG", { errorCorrectionLevel: "L" });
    expect(qr.version).toBe(1);
    // Version 1-L has seven parity symbols, enough to correct three errors.
    damageCodewords(qr, [0, 1, 2, 3, 4, 5, 6, 7]);
    const image = render(qr);
    expect(scanQrImage(image.data, image.width, image.height)).toBeNull();
  });
});
