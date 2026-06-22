import { describe, expect, it } from "vitest";
import { decodeSeal, verifyQRedSeals } from "./qredVerifier.js";

const publicKey = "X0qh5pQ9Joya3katdVpggpkbb7PJ_6oCdp6CkBlfb4U=";
const wrongPublicKey = "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI=";
const seals = [
  "QRED1|DOC-TESTBROWSER|0|2|H4sIAEGQOWoC_y2NW0-DMABG_4rpq8O03cBBsgcYoOFBNi4ykiULl5bVQYtQZMvif7dG376cc5LvDoq2EQOT5w5YwKuxriMTLEAluCRcKrYVnLJabVa0R37krqim7lctQP0_T6xWoRtutcSLEycKs9iLlGfjOJFBqX1E6oe9rdCF3P7qAlJEaY2osYbmsqLKjazhhZwG",
  "QRED1|DOC-TESTBROWSER|1|2|onRJA_b22TrI38VtP-b-kKUOonPerJ3Ghr1I049De8WVeN2F1xnlzk0Liiw-yPehz83KKU9J4J-1C2176ZbZ_CJi295s1I1kHRll0fXqBkNsaNDQME6Qaa2wpT8_mRgvzdUjhBaEKv8iw8gEVzEC3z-Ehhd0LwEAAA==",
];

describe("qredVerifier", () => {
  it("decodes QRed seal metadata", () => {
    expect(decodeSeal(seals[0])).toMatchObject({
      format_id: "QRED1",
      document_id: "DOC-TESTBROWSER",
      chunk_number: 0,
      total_chunks: 2,
    });
  });

  it("reconstructs and verifies a valid sealed document locally", async () => {
    await expect(verifyQRedSeals(seals, publicKey)).resolves.toMatchObject({
      status: "VALID",
      issuer: "QRed QA",
      document_id: "DOC-TESTBROWSER",
      content: "Confidential\n\nDocument",
    });
  });

  it("rejects signatures verified with the wrong public key", async () => {
    await expect(verifyQRedSeals(seals, wrongPublicKey)).resolves.toMatchObject({
      status: "INVALID",
      document_id: "DOC-TESTBROWSER",
      error_message: "Digital signature verification failed",
    });
  });

  it("reports missing chunks without attempting signature verification", async () => {
    await expect(verifyQRedSeals(seals.slice(0, 1), publicKey)).resolves.toMatchObject({
      status: "INCOMPLETE",
      document_id: "DOC-TESTBROWSER",
      error_message: "Missing chunks: [1]",
    });
  });
});
