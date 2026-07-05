import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { qredQrPngDataUrl } from "./qredQr.js";
import { qredTextFromPhotoScanResult } from "./qredVerifier.js";

function decodeDataUrl(dataUrl) {
  const pngBytes = Buffer.from(dataUrl.split(",")[1], "base64");
  const png = PNG.sync.read(pngBytes);
  return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
}

describe("QRed end-to-end scanning", () => {
  it("round-trips the current hidden-payload QR format", async () => {
    const image = decodeDataUrl(await qredQrPngDataUrl("IMG"));
    const code = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });

    expect(code, "new hidden-payload QR should decode").toBeTruthy();
    expect(code.data).toBe("QRED.ORG");
    expect(qredTextFromPhotoScanResult(image.data, image.width, image.height, code)).toBe("IMG");
  });
});
