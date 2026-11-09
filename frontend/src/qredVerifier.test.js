import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import jpeg from "jpeg-js";
import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { createQRedSeals } from "./qredSealer.js";
import { qrPayloadBytes, sealSheetString, sealString } from "./sealFormat.js";
import { compareDocumentText, compareWordSequences, decodeSeal, qredTextFromPhotoScanResult, qredTextFromScanResult, verifyQRedSeals } from "./qredVerifier.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";
const wrongPublicKey = "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI=";

const noisyFixturePath = resolve(process.cwd(), "../tests/qred_hidden_payload_photo.jpg");

function decodeJpegFixture(path) {
  const bytes = readFileSync(path);
  const decoded = jpeg.decode(bytes, { useTArray: true });
  return { data: new Uint8ClampedArray(decoded.data), width: decoded.width, height: decoded.height };
}

async function createTestSeals() {
  const result = await createQRedSeals({
    content: "Confidential\n\nDocument",

    privateKey,
    publicKey,

  });
  return result.seals;
}

describe("qredVerifier", () => {
  it("treats the sheet carrier as placement only and rejects changed bytes, missing chunks and wrong keys", async () => {
    const { seals } = await createQRedSeals({ content: "sample ".repeat(570), encodingStrategy: "plaintext", privateKey, publicKey,
      pageContext: { pageNumber: 1, pageCount: 1 } });
    const sheet = seals.map(sealSheetString);
    expect(await verifyQRedSeals([seals[0], ...sheet], publicKey)).toMatchObject({ status: "VALID", seal_sheet: true });
    expect((await verifyQRedSeals(sheet.slice(1), publicKey)).status).toBe("INCOMPLETE");
    expect((await verifyQRedSeals(sheet, wrongPublicKey)).status).toBe("INVALID");
    const changed = qrPayloadBytes(sheet[0]);
    changed[changed.length - 1] ^= 1;
    expect((await verifyQRedSeals([sealString(changed), ...sheet.slice(1)], publicKey)).status).toBe("INVALID");
  });
  it("does not recover retired padding payloads from a committed blurred JPEG", () => {
    const image = decodeJpegFixture(noisyFixturePath);
    const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });
    expect(code?.data).toBe("QRED.ORG");
    expect(qredTextFromPhotoScanResult(image.data, image.width, image.height, code)).toBe("QRED.ORG");
  });

  it("preserves ordinary QR text", () => {
    expect(qredTextFromScanResult({ data: "https://example.test/plain", binaryData: [1, 2, 3] }))
      .toBe("https://example.test/plain");
    expect(qredTextFromPhotoScanResult(null, 0, 0, { data: "QRED.ORG" })).toBe("QRED.ORG");
  });

  it("decodes QRed seal metadata", async () => {
    const seals = await createTestSeals();
    expect(decodeSeal(seals[0])).toMatchObject({
      format_id: "QRED3",
      chunk_number: 0,
      total_chunks: 1,
    });
  });

  it("reconstructs and verifies a valid sealed document locally", async () => {
    const seals = await createTestSeals();
    await expect(verifyQRedSeals(seals, publicKey)).resolves.toMatchObject({
      status: "VALID",
      content: "Confidential\n\nDocument",
    });
  });


  it("rejects old seal formats rather than reporting them as verified", async () => {
    for (const version of ["1", "2"]) {
      const seal = `https://qred.org/#QRED1?v=${version}&doc=OLD&i=0&n=1&txt=Original`;
      expect(decodeSeal(seal)).toBeNull();
      expect(await verifyQRedSeals([seal], publicKey)).toMatchObject({ status: "ERROR" });
    }
  });

  it("returns recovered content as unverified when no trusted key is available", async () => {
    expect(await verifyQRedSeals(await createTestSeals(), "")).toMatchObject({
      status: "UNVERIFIED", signature_valid: false, metadata_authenticated: false, content: "Confidential\n\nDocument",
    });
  });

  it("rejects signatures verified with the wrong public key", async () => {
    const seals = await createTestSeals();
    await expect(verifyQRedSeals(seals, wrongPublicKey)).resolves.toMatchObject({
      status: "INVALID",
      error_message: "Digital signature verification failed",
    });
  });

  it("reports missing chunks without attempting signature verification", async () => {
    const result = await createQRedSeals({
      content: "Confidential\n\nDocument".repeat(500),
      privateKey,
      publicKey,

      encodingStrategy: "plaintext",
    });
    await expect(verifyQRedSeals(result.seals.slice(0, 1), publicKey)).resolves.toMatchObject({
      status: "INCOMPLETE",
      error_message: expect.stringMatching(/^Missing chunks: \[/),
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
