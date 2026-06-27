import { describe, expect, it } from "vitest";
import { createQRedSeals } from "./qredSealer.js";
import { verifyQRedSeals } from "./qredVerifier.js";
import { validateSimpleEnglish } from "./textRecipes.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";

describe("browser QRed sealing", () => {
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

  it("supports Recipe 1 for compact sealing when reversible", async () => {
    const sealed = await createQRedSeals({
      content: "the document and the page",
      issuer: "QRed Browser Demo",
      privateKey,
      publicKey,
      documentId: "DOC-BROWSER-RECIPE1",
      encodingStrategy: "b45",
    });

    expect(sealed.selected_recipe).toBe("b45");
    expect(sealed.encoding).toBe("b45");
    expect(sealed.candidate_reports.some((report) => report.encoding === "b45" && report.reversible)).toBe(true);
    await expect(verifyQRedSeals(sealed.seals, publicKey)).resolves.toMatchObject({
      status: "VALID",
      issuer: "QRed Browser Demo",
      document_id: "DOC-BROWSER-RECIPE1",
      content: "the document and the page",
    });
  });

  it("round-trips b45 escapes for newline, hash, and utf-8", () => {
    const original = "Hello, Alfred!\nhttps://qred.org/#QRED1\né";
    const result = validateSimpleEnglish(original);

    expect(result.reversible).toBe(true);
    expect(result.restored).toBe(original);
    expect(result.compact).toContain("%23");
    expect(result.compact).toContain("%0A");
    expect(result.compact).toContain("%C3%A9");
  });
});
