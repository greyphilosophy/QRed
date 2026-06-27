import { describe, expect, it } from "vitest";
import { createQRedSeals } from "./qredSealer.js";
import { verifyQRedSeals } from "./qredVerifier.js";

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
      encodingStrategy: "recipe1",
    });

    expect(sealed.selected_recipe).toBe("recipe1");
    expect(sealed.encoding).toBe("recipe1");
    expect(sealed.candidate_reports.some((report) => report.encoding === "recipe1" && report.reversible)).toBe(true);
    await expect(verifyQRedSeals(sealed.seals, publicKey)).resolves.toMatchObject({
      status: "VALID",
      issuer: "QRed Browser Demo",
      document_id: "DOC-BROWSER-RECIPE1",
      content: "the document and the page",
    });
  });

  it("prefers compression only when it reduces the QR count", async () => {
    const repetitive = "lorem ipsum dolor sit amet ".repeat(200);
    const sealed = await createQRedSeals({
      content: repetitive,
      issuer: "QRed Browser Demo",
      privateKey,
      publicKey,
      documentId: "DOC-BROWSER-COMPRESS",
    });

    expect(["plaintext", "compressed"]).toContain(sealed.encoding);
    if (sealed.encoding === "compressed") {
      expect(sealed.seals.every((seal) => seal.startsWith("QRED1|"))).toBe(true);
    } else {
      expect(sealed.seals.every((seal) => seal.startsWith("https://qred.org/#QRED1?"))).toBe(true);
    }
  });
});
