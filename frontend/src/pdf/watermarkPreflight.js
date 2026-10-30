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

// The small "Verify at qred.org" navigation QR is deliberately NOT a seal.
// The verifier recognizes it and guides the user to scan the pale watermark.
// During sealing, mask that known navigation area before looking for signed
// seals. Otherwise a high-contrast link can monopolize the limited full-page
// decode attempts and cause a false footer fallback on page one.
function hideEntryCode(image, entry) {
  if (!entry) return true;
  const { bounds, scale, width, height, data } = image;
  if (!bounds || !Number.isFinite(scale) || scale <= 0) return false;
  const left = Math.max(0, Math.floor((entry.x - bounds.x) * scale) - 2);
  const right = Math.min(width, Math.ceil((entry.x + entry.width - bounds.x) * scale) + 2);
  const top = Math.max(0, Math.floor((bounds.y + bounds.height - entry.y - entry.height) * scale) - 2);
  const bottom = Math.min(height, Math.ceil((bounds.y + bounds.height - entry.y) * scale) + 2);
  if (right <= left || bottom <= top) return false;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const offset = (y * width + x) * 4;
      data[offset] = data[offset + 1] = data[offset + 2] = data[offset + 3] = 255;
    }
  }
  return true;
}

// Verify the exact signed bytes by discovering symbols from the *whole page*.
// A matching visible QRED.ORG string alone is never enough. An unrelated QR
// may be skipped, but bounded attempts prevent excessive sealing time.
export function scanAllSealsFromPage(image, expectedSeals, { entry = null } = {}) {
  if (!expectedSeals.length) return true;
  const remaining = new Set(expectedSeals);
  if (remaining.size !== expectedSeals.length) return false;
  const working = { ...image, data: new Uint8ClampedArray(image.data) };
  if (!hideEntryCode(working, entry)) return false;
  for (let attempt = 0; attempt < Math.min(8, expectedSeals.length + 2); attempt++) {
    // Fast fail-closed pass: one raw decode and one local-watermark recovery.
    // The verifier can still try all of its normal camera recovery scales.
    const code = scanQrImage(working.data, working.width, working.height,
      { tryRescaling: false, maxAttempts: 3 });
    if (!code?.location) return false;
    const payload = hiddenPayloadFromScanResult(code);
    if (remaining.has(payload)) remaining.delete(payload);
    if (!remaining.size) return true;
    if (!obscureDetectedCode(working, code.location)) return false;
  }
  return false;
}
