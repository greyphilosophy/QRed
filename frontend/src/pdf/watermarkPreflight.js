import { scanQrImage } from "../qr/scanQrImage.js";
import { hiddenPayloadFromScanResult } from "../qr/hiddenPayload.js";

// A deliberately mild, deterministic approximation of a photographed print.
// This is a risk screen, not a guarantee for every printer or camera.
export function simulatePrintPhoto(image) {
  const { data, width, height } = image;
  const output = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    const shade = 1 - 0.06 * y / Math.max(1, height - 1);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const neighbor = (y * width + Math.min(width - 1, x + 1)) * 4;
      // Soften square edges and lower ink contrast as happens after printing.
      const grain = ((x * 13 + y * 17) % 5) - 2;
      for (let channel = 0; channel < 3; channel++) {
        const softened = data[i + channel] * 0.85 + data[neighbor + channel] * 0.15;
        output[i + channel] = Math.max(0, Math.min(255,
          (255 - (255 - softened) * 0.94) * shade + grain));
      }
      output[i + 3] = 255;
    }
  }
  return { data: output, width, height };
}

function obscureDetectedCode(image, location) {
  const points = ["topLeftCorner", "topRightCorner", "bottomRightCorner", "bottomLeftCorner"]
    .map(key => location?.[key]);
  if (points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) return false;
  const left = Math.max(0, Math.floor(Math.min(...points.map(point => point.x)) - 8));
  const top = Math.max(0, Math.floor(Math.min(...points.map(point => point.y)) - 8));
  const right = Math.min(image.width, Math.ceil(Math.max(...points.map(point => point.x)) + 8));
  const bottom = Math.min(image.height, Math.ceil(Math.max(...points.map(point => point.y)) + 8));
  if (right <= left || bottom <= top) return false;
  // Only conceal the found symbol. Never use expected layout coordinates here:
  // the preflight must locate watermark QR codes as an independent camera would.
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const i = (y * image.width + x) * 4;
    image.data[i] = image.data[i + 1] = image.data[i + 2] = image.data[i + 3] = 255;
  }
  return true;
}

// Verify the exact signed bytes by discovering symbols from the *whole page*.
// A matching visible QRED.ORG string alone is never enough. An unrelated QR
// may be skipped, but bounded attempts prevent excessive sealing time.
export function scanAllSealsFromPage(image, expectedSeals) {
  if (!expectedSeals.length) return true;
  const remaining = new Set(expectedSeals);
  if (remaining.size !== expectedSeals.length) return false;
  const working = { ...image, data: new Uint8ClampedArray(image.data) };
  for (let attempt = 0; attempt < Math.min(8, expectedSeals.length + 2); attempt++) {
    // Fast fail-closed pass: one raw decode and one local-watermark recovery.
    // The verifier can still try all of its normal camera recovery scales.
    const code = scanQrImage(working.data, working.width, working.height,
      { tryRescaling: false, maxAttempts: 2 });
    if (!code?.location) return false;
    const payload = hiddenPayloadFromScanResult(code);
    if (remaining.has(payload)) remaining.delete(payload);
    if (!remaining.size) return true;
    if (!obscureDetectedCode(working, code.location)) return false;
  }
  return false;
}
