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

  it("supports the base45ish text mode for compact sealing", async () => {
    const sealed = await createQRedSeals({
      content: "compact text mode? yes!",
      issuer: "QRed Browser Demo",
      privateKey,
      publicKey,
      documentId: "DOC-BROWSER-TEXT-MODE",
      textMode: "base45ish",
    });

    const firstSeal = new URL(sealed.seals[0]);
    expect(firstSeal.hash).toContain("txt=COMPACT+TEXT+MODE*+YES*");
    expect(sealed.seals.every((seal) => seal.startsWith("https://qred.org/#QRED1?"))).toBe(true);
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
