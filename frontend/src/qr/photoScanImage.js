import { MAX_ERASURE_SCAN_PIXELS } from "./scanErasureSeals.js";

const MAX_PHOTO_PIXELS = 80_000_000, DISCOVERY_PIXELS = 2_000_000;

export function validatePhotoImage(image) {
  const { data, width, height } = image || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || width * height > MAX_PHOTO_PIXELS || !ArrayBuffer.isView(data)
    || data.BYTES_PER_ELEMENT !== 1 || data.length !== width * height * 4) {
    throw new Error("This photo cannot be scanned at its current size. Choose a smaller photo.");
  }
}

// Discovery alone may use a smaller raster. Never replace the original photo,
// its coordinate system, or the pixels retained for OCR. This is area averaging
// of observed RGBA pixels, not thresholding, sharpening, or invented evidence.
export function erasureDiscoveryImage(image, { shouldContinue = () => true, signal } = {}) {
  validatePhotoImage(image);
  const continuing = () => { signal?.throwIfAborted(); return shouldContinue(); };
  if (!continuing()) return null;
  const { data, width, height } = image;
  if (width * height <= MAX_ERASURE_SCAN_PIXELS) return image;
  const scale = Math.sqrt(DISCOVERY_PIXELS / (width * height));
  let w = Math.max(1, Math.floor(width * scale)), h = Math.max(1, Math.floor(height * scale));
  // Rounding a very thin image up to one pixel must not evade the output cap.
  if (w * h > DISCOVERY_PIXELS) {
    if (w > h) w = Math.floor(DISCOVERY_PIXELS / h);
    else h = Math.floor(DISCOVERY_PIXELS / w);
  }
  const pixels = new Uint8ClampedArray(w * h * 4), sx = width / w, sy = height / h;
  for (let y = 0; y < h; y++) {
    if (!continuing()) return null; // Discard incomplete copies.
    const top = y * sy, bottom = (y + 1) * sy;
    for (let x = 0; x < w; x++) {
      if ((x & 255) === 0 && !continuing()) return null;
      const left = x * sx, right = (x + 1) * sx;
      let r = 0, g = 0, b = 0, a = 0;
      for (let yy = Math.floor(top); yy < Math.min(height, Math.ceil(bottom)); yy++) {
        const wy = Math.min(bottom, yy + 1) - Math.max(top, yy);
        for (let xx = Math.floor(left); xx < Math.min(width, Math.ceil(right)); xx++) {
          const weight = wy * (Math.min(right, xx + 1) - Math.max(left, xx)), at = (yy * width + xx) * 4;
          r += data[at] * weight; g += data[at + 1] * weight;
          b += data[at + 2] * weight; a += data[at + 3] * weight;
        }
      }
      const at = (y * w + x) * 4, area = sx * sy;
      pixels[at] = r / area; pixels[at + 1] = g / area;
      pixels[at + 2] = b / area; pixels[at + 3] = a / area;
    }
  }
  return continuing() ? { data: pixels, width: w, height: h } : null;
}
