import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { sealPdfInBrowser } from "./pdfClientSeal.js";
import { verifyQRedSeals } from "./qredVerifier.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";

async function makePdfFile() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 300]);
  page.drawText("Static deployment PDF");
  const bytes = await pdf.save();
  return new File([bytes], "static.pdf", { type: "application/pdf" });
}

describe("browser PDF sealing", () => {
  it("stamps a PDF and returns verifier-compatible manifest seals", async () => {
    const file = await makePdfFile();

    const { blob, sealResult } = await sealPdfInBrowser({
      file,
      issuer: "QRed Browser Demo",
      privateKey,
      publicKey,
    });

    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(file.size);
    expect(sealResult.seals.length).toBeGreaterThan(0);
    await expect(verifyQRedSeals(sealResult.seals, publicKey)).resolves.toMatchObject({
      status: "VALID",
      issuer: "QRed Browser Demo",
    });
  });
});
