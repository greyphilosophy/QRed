import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import jpeg from "jpeg-js";
import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { createQRedSeals } from "./qredSealer.js";
import { compareDocumentText, compareWordSequences, decodeSeal, extractHiddenQRedPayload, extractHiddenQRedPayloadFromImage, qredTextFromPhotoScanResult, qredTextFromScanResult, verifyQRedSeals } from "./qredVerifier.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";
const wrongPublicKey = "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI=";
const staticDemoPublicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";

const noisyFixturePath = resolve(process.cwd(), "../tests/qred_hidden_payload_photo.jpg");

function decodePhotograph(path) {
  const bytes = readFileSync(path);
  const decoded = jpeg.decode(bytes, { useTArray: true });
  return { data: new Uint8ClampedArray(decoded.data), width: decoded.width, height: decoded.height };
}

function backendFramedPayloadBytes(payload) {
  const payloadBytes = new TextEncoder().encode(payload);
  return new Uint8Array([
    (payloadBytes.length >> 8) & 0xff,
    payloadBytes.length & 0xff,
    ...payloadBytes,
  ]);
}

function versionOneDataOffset() {
  return 8;
}

const formatBits = 0x77c4;
const formatBitPositions = [
  [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  [20, 8], [19, 8], [18, 8], [17, 8], [16, 8], [15, 8], [14, 8], [8, 13], [8, 14], [8, 15], [8, 16], [8, 17], [8, 18], [8, 19], [8, 20],
];

function qrMaskBit(mask, row, col) {
  return mask === 0 ? (row + col) % 2 === 0 : false;
}

function isVersionOneFunctionModule(row, col) {
  return (row < 9 && col < 9) || (row < 9 && col >= 13) || (row >= 13 && col < 9) || row === 6 || col === 6;
}

function matrixFromCodewords(codewords) {
  const size = 21;
  const matrix = Array.from({ length: size }, () => Array(size).fill(false));
  const bits = Array.from(codewords, (byte) => Array.from({ length: 8 }, (_, bit) => (byte >> (7 - bit)) & 1)).flat();
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1;
    for (let vertical = 0; vertical < size; vertical += 1) {
      const row = upward ? size - 1 - vertical : vertical;
      for (const col of [right, right - 1]) {
        if (isVersionOneFunctionModule(row, col)) continue;
        const bit = bits[bitIndex] || 0;
        matrix[row][col] = Boolean(bit ^ (qrMaskBit(0, row, col) ? 1 : 0));
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
  for (const [index, [row, col]] of formatBitPositions.entries()) {
    matrix[row][col] = Boolean((formatBits >> (14 - (index % 15))) & 1);
  }
  return matrix;
}

function imageDataFromMatrix(matrix, modulePixels = 2, darkValue = 0, lightValue = 255) {
  const size = matrix.length;
  const width = size * modulePixels;
  const imageData = new Uint8ClampedArray(width * width * 4);
  for (let row = 0; row < width; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const dark = matrix[Math.floor(row / modulePixels)][Math.floor(col / modulePixels)];
      const value = dark ? darkValue : lightValue;
      const index = ((row * width) + col) * 4;
      imageData[index] = value;
      imageData[index + 1] = value;
      imageData[index + 2] = value;
      imageData[index + 3] = 255;
    }
  }
  return { imageData, width, height: width };
}

async function createTestSeals() {
  const result = await createQRedSeals({
    content: "Confidential\n\nDocument",
    issuer: "QRed QA",
    privateKey,
    publicKey,
    documentId: "DOC-TESTBROWSER",
  });
  return result.seals;
}

describe("qredVerifier", () => {
  it("extracts length-framed scanner-safe QRed data from the post-terminator byte offset", () => {
    const payload = "https://qred.org/#QRED1?doc=DOC&i=0&n=1&rc=b45&txt=HELLO";
    const binaryData = new Uint8Array([
      0x20, 0x3d, 0x44, 0x44, 0xad, 0x4f, 0x50, 0x40,
      ...backendFramedPayloadBytes(payload),
      0xec, 0x11,
    ]);

    expect(extractHiddenQRedPayload(binaryData, 1)).toBe(payload);
    expect(qredTextFromScanResult({ data: "QRED.ORG", binaryData, version: 1 })).toBe(payload);
    expect(qredTextFromScanResult({ data: "https://qred.org/#QRED1?sig?garbled", binaryData, version: 1 })).toBe(payload);
  });

  it("extracts compressed and encoded QRed chunk text from compact backend framing", () => {
    const payload = "rc=brotli&txt=G8YA%2BE-brotli_payload";
    const binaryData = new Uint8Array([
      0x20, 0x3d, 0x44, 0x44, 0xad, 0x4f, 0x50, 0x40,
      ...backendFramedPayloadBytes(payload),
      0xec, 0x11,
    ]);

    expect(extractHiddenQRedPayload(binaryData, 1)).toBe(payload);
  });

  it("does not extract unframed legacy printable bytes", () => {
    const binaryData = new Uint8Array([
      0x20, 0x3d, 0x44, 0x44, 0xad, 0x4f, 0x50, 0x40,
      ...new TextEncoder().encode("legacy printable payload"),
      0xec, 0x11,
    ]);

    expect(extractHiddenQRedPayload(binaryData, 1)).toBeNull();
    expect(qredTextFromScanResult({ data: "QRED.ORG", binaryData, version: 1 })).toBe("QRED.ORG");
  });

  it("extracts length-framed hidden payloads from deinterleaved QR image codewords", () => {
    const payload = "IMG";
    const dataCodewords = new Uint8Array(19);
    dataCodewords.set([0x20, 0x3d, 0x44, 0x44, 0xad, 0x4f, 0x50, 0x40], 0);
    dataCodewords.set(backendFramedPayloadBytes(payload), versionOneDataOffset());
    const allCodewords = new Uint8Array(26);
    allCodewords.set(dataCodewords);
    const { imageData, width, height } = imageDataFromMatrix(matrixFromCodewords(allCodewords));

    expect(extractHiddenQRedPayloadFromImage(imageData, width, height, {
      data: "QRED.ORG",
      version: 1,
      location: {
        topLeftCorner: { x: 0, y: 0 },
        topRightCorner: { x: width, y: 0 },
        bottomLeftCorner: { x: 0, y: height },
        bottomRightCorner: { x: width, y: height },
      },
    })).toBe(payload);
  });

  it("recovers hidden payloads from low-contrast photographed modules with adaptive thresholding", () => {
    const payload = "LOW";
    const dataCodewords = new Uint8Array(19);
    dataCodewords.set([0x20, 0x3d, 0x44, 0x44, 0xad, 0x4f, 0x50, 0x40], 0);
    dataCodewords.set(backendFramedPayloadBytes(payload), versionOneDataOffset());
    const allCodewords = new Uint8Array(26);
    allCodewords.set(dataCodewords);
    const { imageData, width, height } = imageDataFromMatrix(matrixFromCodewords(allCodewords), 2, 140, 180);

    expect(extractHiddenQRedPayloadFromImage(imageData, width, height, {
      data: "QRED.ORG",
      version: 1,
      location: {
        topLeftCorner: { x: 0, y: 0 },
        topRightCorner: { x: width, y: 0 },
        bottomLeftCorner: { x: 0, y: height },
        bottomRightCorner: { x: width, y: height },
      },
    })).toBe(payload);
  });

  it("recovers hidden payloads from a photographed QRed image that still decodes the visible QR", () => {
    const payload = "IMG";
    const image = decodePhotograph(noisyFixturePath);
    const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });

    expect(code, `jsQR did not detect a QR code in ${noisyFixturePath}`).toBeTruthy();
    expect(extractHiddenQRedPayloadFromImage(image.data, image.width, image.height, code)).toBe(payload);
    expect(qredTextFromPhotoScanResult(image.data, image.width, image.height, code)).toBe(payload);
  });

  it("returns no hidden image payload when scan geometry is unavailable", () => {
    expect(extractHiddenQRedPayloadFromImage(new Uint8ClampedArray(), 0, 0, { data: "QRED.ORG" })).toBeNull();
  });

  it("recovers a hidden payload from the QR image even when jsQR only exposes visible text bytes", () => {
    const payload = "IMG-ONLY";
    const dataCodewords = new Uint8Array(19);
    dataCodewords.set([0x20, 0x3d, 0x44, 0x44, 0xad, 0x4f, 0x50, 0x40], 0);
    dataCodewords.set(backendFramedPayloadBytes(payload), versionOneDataOffset());
    const allCodewords = new Uint8Array(26);
    allCodewords.set(dataCodewords);
    const { imageData, width, height } = imageDataFromMatrix(matrixFromCodewords(allCodewords));

    expect(qredTextFromPhotoScanResult(imageData, width, height, {
      data: "QRED.ORG",
      binaryData: new Uint8Array([0x20, 0x3d, 0x44, 0x44, 0xad, 0x4f, 0x50, 0x40]),
      version: 1,
      location: {
        topLeftCorner: { x: 0, y: 0 },
        topRightCorner: { x: width, y: 0 },
        bottomLeftCorner: { x: 0, y: height },
        bottomRightCorner: { x: width, y: height },
      },
    })).toBe(payload);
  });

  it("falls back to the visible scan text when photo geometry is unavailable", () => {
    expect(qredTextFromPhotoScanResult(null, 0, 0, { data: "https://example.test/plain" }))
      .toBe("https://example.test/plain");
    expect(qredTextFromPhotoScanResult(undefined, undefined, undefined, { data: "QRED.ORG" }))
      .toBe("QRED.ORG");
  });

  it("ignores standard QR padding bytes when no hidden carrier payload is present", () => {
    const binaryData = new Uint8Array([
      0x20, 0x3d, 0x44, 0x44, 0xad, 0x4f, 0x50, 0x40,
      0xec, 0x11, 0xec, 0x11,
    ]);

    expect(qredTextFromScanResult({ data: "QRED.ORG", binaryData, version: 1 })).toBe("QRED.ORG");
  });

  it("falls back to normal QR text when no scanner-safe hidden payload is present", () => {
    expect(qredTextFromScanResult({ data: "https://example.test/plain", binaryData: new Uint8Array([1, 2, 3]) }))
      .toBe("https://example.test/plain");
  });

  it("decodes QRed seal metadata", async () => {
    const seals = await createTestSeals();
    expect(decodeSeal(seals[0])).toMatchObject({
      format_id: "QRED1",
      document_id: "DOC-TESTBROWSER",
      chunk_number: 0,
      total_chunks: 1,
    });
  });

  it("reconstructs and verifies a valid sealed document locally", async () => {
    const seals = await createTestSeals();
    await expect(verifyQRedSeals(seals, publicKey)).resolves.toMatchObject({
      status: "VALID",
      issuer: "QRed QA",
      document_id: "DOC-TESTBROWSER",
      content: "Confidential\n\nDocument",
    });
  });


  it("verifies the sample plaintext fragment with the static demo public key", async () => {
    const fragmentSeal = "https://qred.org/#QRED1?v=1&alg=Ed25519&doc=DOC-A58A798C5FB2&i=0&n=1&iss=QRed+Demo+Authority&kid=da522162396ab2d0&ts=2026-06-25T03%3A46%3A04.757Z&sig=LvusYUa1V3MtKgfVLeHbzMan8tDGQIpakRTJ39WD-LeiXzCBSMOrqNjSUNj7QyzfFhV2H5QpNnMKvjz9PWh_CA&txt=PDF+file%3A+Minutes_2023_05_23.pdf%0ASize%3A+346921+bytes%0ASHA-256%3A+c08048143569b6324147179a9a3d9e6b85d386aedff1260783d5fafd7b7a5f63";

    await expect(verifyQRedSeals([fragmentSeal], staticDemoPublicKey)).resolves.toMatchObject({
      status: "VALID",
      issuer: "QRed Demo Authority",
      document_id: "DOC-A58A798C5FB2",
      content: "PDF file: Minutes_2023_05_23.pdf\nSize: 346921 bytes\nSHA-256: c08048143569b6324147179a9a3d9e6b85d386aedff1260783d5fafd7b7a5f63",
    });
  });

  it("returns plaintext fragment content when no public key is available", async () => {
    const fragmentSeal = "https://qred.org/#QRED1?v=1&alg=Ed25519&doc=DOC-A58A798C5FB2&i=0&n=1&iss=QRed+Demo+Authority&kid=da522162396ab2d0&ts=2026-06-25T03%3A46%3A04.757Z&sig=LvusYUa1V3MtKgfVLeHbzMan8tDGQIpakRTJ39WD-LeiXzCBSMOrqNjSUNj7QyzfFhV2H5QpNnMKvjz9PWh_CA&txt=PDF+file%3A+Minutes_2023_05_23.pdf%0ASize%3A+346921+bytes%0ASHA-256%3A+c08048143569b6324147179a9a3d9e6b85d386aedff1260783d5fafd7b7a5f63";

    await expect(verifyQRedSeals([fragmentSeal], "")).resolves.toMatchObject({
      status: "UNVERIFIED",
      issuer: "QRed Demo Authority",
      document_id: "DOC-A58A798C5FB2",
      content: "PDF file: Minutes_2023_05_23.pdf\nSize: 346921 bytes\nSHA-256: c08048143569b6324147179a9a3d9e6b85d386aedff1260783d5fafd7b7a5f63",
      error_message: "No trusted public key available for signature verification",
    });
  });

  it("rejects signatures verified with the wrong public key", async () => {
    const seals = await createTestSeals();
    await expect(verifyQRedSeals(seals, wrongPublicKey)).resolves.toMatchObject({
      status: "INVALID",
      document_id: "DOC-TESTBROWSER",
      error_message: "Digital signature verification failed",
    });
  });

  it("reports missing chunks without attempting signature verification", async () => {
    const result = await createQRedSeals({
      content: "Confidential\n\nDocument".repeat(500),
      issuer: "QRed QA",
      privateKey,
      publicKey,
      documentId: "DOC-TESTBROWSER",
      encodingStrategy: "plaintext",
    });
    await expect(verifyQRedSeals(result.seals.slice(0, 1), publicKey)).resolves.toMatchObject({
      status: "INCOMPLETE",
      document_id: "DOC-TESTBROWSER",
      error_message: "Missing chunks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]",
    });
  });

  it("shares word sequence comparison for OCR overlays", () => {
    const comparison = compareWordSequences(["The", "original", "document", "text"], ["The", "altered", "document", "text", "plus"]);

    expect(comparison.matchedWords).toBe(3);
    expect(comparison.missingWords).toBe(1);
    expect(comparison.extraWords).toBe(2);
    expect(comparison.missingQrWords).toEqual(["original"]);
    expect(Array.from(comparison.matchedPage)).toEqual([0, 2, 3]);
  });

  it("handles punctuation, case, and repeated words in word sequence matching", () => {
    const comparison = compareWordSequences(["Alpha,", "beta", "alpha", "gamma!"], ["alpha", "ALPHA", "gamma", "delta"]);

    expect(comparison.matchedWords).toBe(3);
    expect(comparison.missingWords).toBe(1);
    expect(comparison.extraWords).toBe(1);
    expect(comparison.missingQrWords).toEqual(["beta"]);
    expect(Array.from(comparison.matchedQr)).toEqual([0, 2, 3]);
    expect(Array.from(comparison.matchedPage)).toEqual([0, 1, 2]);
  });

  it("ignores non-word tokens when comparing word sequences", () => {
    const comparison = compareWordSequences(["Signed", "---", "Document"], ["signed", "document", "***"]);

    expect(comparison.matchedWords).toBe(2);
    expect(comparison.missingWords).toBe(0);
    expect(comparison.extraWords).toBe(0);
    expect(comparison.missingQrWords).toEqual([]);
  });

  it("compares QR text to OCR page text for matched, missing, and extra words", () => {
    const comparison = compareDocumentText("The original document text", "The altered document text plus");

    expect(comparison.matchedWords).toBe(3);
    expect(comparison.missingWords).toBe(1);
    expect(comparison.extraWords).toBe(2);
    expect(comparison.qrTokens.filter((token) => token.status === "missing").map((token) => token.token)).toEqual(["original"]);
    expect(comparison.pageTokens.filter((token) => token.status === "extra").map((token) => token.token)).toEqual(["altered", "plus"]);
  });
});
