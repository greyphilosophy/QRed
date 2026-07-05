import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import QRCode from "qrcode";
import { createQRedSeals } from "./qredSealer.js";
import { qredQrPngDataUrl } from "./qredQr.js";
import { qredTextFromPhotoScanResult } from "./qredVerifier.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";

function decodeDataUrl(dataUrl) {
  const pngBytes = Buffer.from(dataUrl.split(",")[1], "base64");
  const png = PNG.sync.read(pngBytes);
  return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
}

describe("QRed end-to-end scanning", () => {
  it("round-trips the old fragment QR format and the newer hidden-payload QR format", async () => {
    const sealed = await createQRedSeals({
      content: "End to end manifest",
      issuer: "QRed QA",
      privateKey,
      publicKey,
      documentId: "DOC-E2E",
      encodingStrategy: "plaintext",
    });

    const oldSealImage = decodeDataUrl(await QRCode.toDataURL(sealed.seals[0], { errorCorrectionLevel: "M", margin: 4, width: 360 }));
    const oldCode = jsQR(oldSealImage.data, oldSealImage.width, oldSealImage.height, { inversionAttempts: "attemptBoth" });
    expect(oldCode, "old fragment QR should decode").toBeTruthy();
    expect(oldCode.data).toContain("#QRED1?");

    const newSealImage = decodeDataUrl(await qredQrPngDataUrl("IMG"));
    const newCode = jsQR(newSealImage.data, newSealImage.width, newSealImage.height, { inversionAttempts: "attemptBoth" });
    expect(newCode, "new hidden-payload QR should decode").toBeTruthy();
    expect(newCode.data).toBe("QRED.ORG");

    expect(qredTextFromPhotoScanResult(newSealImage.data, newSealImage.width, newSealImage.height, newCode)).toBe("IMG");
  });
});
