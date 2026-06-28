import { describe, expect, it } from "vitest";
import { createQRedSeals } from "./qredSealer.js";
import { compareDocumentText, compareWordSequences, decodeSeal, verifyQRedSeals } from "./qredVerifier.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";
const wrongPublicKey = "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI=";
const staticDemoPublicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";
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
