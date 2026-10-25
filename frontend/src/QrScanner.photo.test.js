import { readFileSync } from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { qrScanAction } from "./QrScanner.jsx";
import { scanQrImage } from "./qr/scanQrImage.js";
import { verifyQRedSeals, VISIBLE_QR_TEXT } from "./qredVerifier.js";

const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";
const wrongPublicKey = "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI=";

function scanJpeg(bytes) {
  const image = jpeg.decode(bytes, { useTArray: true });
  const pixels = new Uint8ClampedArray(image.data);
  const code = scanQrImage(pixels, image.width, image.height);
  expect(code?.data).toBe(VISIBLE_QR_TEXT);
  const action = qrScanAction(pixels, image.width, image.height, code, { returnPayload: true });
  expect(action.status).toBe("found");
  return action.text;
}

describe("QrScanner JPEG regressions", () => {
  it("recovers the known payload from the committed blurred JPEG", () => {
    // The historical fixture contains only IMG. Its physical-camera provenance
    // is undocumented; this checks its pixels without claiming field coverage.
    const bytes = readFileSync(new URL("../../tests/qred_hidden_payload_photo.jpg", import.meta.url));
    expect(scanJpeg(bytes)).toBe("IMG");
  });

  it.each([85, 50])("verifies a signed PDF seal after JPEG compression at quality %i", async quality => {
    // A fixed synthetic PDF render supplies independent signed fixture bytes.
    // JPEG re-encoding is simulated compression, not a print/camera capture.
    const png = PNG.sync.read(readFileSync(new URL("../../tests/fixtures/compact-qr/invoice-footer-300dpi.png", import.meta.url)));
    const payload = scanJpeg(jpeg.encode(png, quality).data);
    expect(await verifyQRedSeals([payload], publicKey)).toMatchObject({
      status: "VALID", signature_valid: true, metadata_authenticated: true,
      content: expect.stringContaining("Approved total: $123.45"),
    });
    expect(await verifyQRedSeals([payload], wrongPublicKey)).toMatchObject({ status: "INVALID" });
  });
});
