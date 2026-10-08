import { describe, expect, it } from "vitest";
import { createQRedSeals } from "./qredSealer.js";
import { verifyQRedSeals } from "./qredVerifier.js";
import { validateSimpleEnglish } from "./textRecipes.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";

function changed(seal, field, value) {
  const url = new URL(seal);
  const params = new URLSearchParams(url.hash.slice("#QRED1?".length));
  params.set(field, value);
  url.hash = `QRED1?${params}`;
  return url.href;
}

describe("browser QRed sealing", () => {
  it.each([
    ["iss", "Another Authority"], ["doc", "ANOTHER-DOCUMENT"],
    ["kid", "0000000000000000"], ["ts", "2000-01-01T00:00:00Z"],
    ["txt", "The approved total is 999.99 dollars."], ["v", "1"], ["alg", "unknown"],
  ])("rejects tampering with %s", async (field, value) => {
    const { seals } = await createQRedSeals({ content: "The approved total is 123.45 dollars.", issuer: "QA", privateKey, publicKey });
    const result = await verifyQRedSeals([changed(seals[0], field, value)], publicKey);
    expect(["INVALID", "ERROR"]).toContain(result.status);
    expect(result.metadata_authenticated).not.toBe(true);
  });

  it("requires a matching public/private keypair and nonempty text", async () => {
    const options = { content: "Hello", issuer: "QA", privateKey, publicKey };
    await expect(createQRedSeals({ ...options, publicKey: "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI=" })).rejects.toThrow(/does not match/);
    await expect(createQRedSeals({ ...options, content: " \n " })).rejects.toThrow(/empty document/);
    await expect(createQRedSeals({ ...options, encodingStrategy: "brotli" })).rejects.toThrow(/Unsupported encoding/);
  });

  it("collects Unicode chunks out of order without splitting surrogate pairs", async () => {
    const content = "Hello 🐈 café\n".repeat(150).trim();
    const { seals } = await createQRedSeals({ content, issuer: "QA", privateKey, publicKey, encodingStrategy: "plaintext" });
    expect(seals.length).toBeGreaterThan(1);
    expect(await verifyQRedSeals([...seals].reverse(), publicKey)).toMatchObject({ status: "VALID", content });
    expect(await verifyQRedSeals(seals.slice(1), publicKey)).toMatchObject({ status: "INCOMPLETE" });
    expect(await verifyQRedSeals([...seals, seals[0]], publicKey)).toMatchObject({ status: "VALID" });
    expect(await verifyQRedSeals([...seals, changed(seals[0], "txt", "altered")], publicKey)).toMatchObject({ status: "INVALID" });
    expect(await verifyQRedSeals([seals[0], changed(seals[1], "iss", "Another authority"), ...seals.slice(2)], publicKey)).toMatchObject({ status: "INVALID" });
  });

  it.each([["i", "-1"], ["i", "0oops"], ["n", "0"], ["n", "999999999"], ["i", "1"]])("rejects invalid chunk coordinates %s=%s", async (field, value) => {
    const { seals } = await createQRedSeals({ content: "Hello", issuer: "QA", privateKey, publicKey });
    expect(await verifyQRedSeals([changed(seals[0], field, value)], publicKey)).toMatchObject({ status: "ERROR" });
  });

  it("creates seals that the local verifier accepts", async () => {
    const sealed = await createQRedSeals({
      content: "Browser sealed PDF manifest",
      issuer: "QRed Browser Demo",
      privateKey,
      publicKey,
      documentId: "DOC-BROWSER-E2E",
    });

    expect(sealed.seals.length).toBeGreaterThan(0);
    await expect(verifyQRedSeals(sealed.seals, publicKey)).resolves.toMatchObject({
      status: "VALID",
      issuer: "QRed Browser Demo",
      document_id: "DOC-BROWSER-E2E",
      content: "Browser sealed PDF manifest",
    });
  });

  it("uses QR capacity instead of a fixed 1200-character chunk cap", async () => {
    const longSimpleEnglish = "the document and the page ".repeat(70);

    const sealed = await createQRedSeals({
      content: longSimpleEnglish,
      issuer: "QRed Browser Demo",
      privateKey,
      publicKey,
      documentId: "DOC-BROWSER-CAPACITY",
      encodingStrategy: "b45",
    });

    expect(sealed.selected_recipe).toBe("b45");
    expect(sealed.seals[0].length).toBeGreaterThan(1200);
  });

  it("round-trips b45 escapes for newline, hash, and utf-8", () => {
    const original = "Hello, Alfred!\nhttps://qred.org/#QRED1\né";
    const result = validateSimpleEnglish(original);

    expect(result.reversible).toBe(true);
    expect(result.restored).toBe(original);
    expect(result.compact).toContain("+3");
    expect(result.compact).toContain("%0A");
    expect(result.compact).toContain("%C3%A9");
  });
});
