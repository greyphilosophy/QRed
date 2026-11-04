import { decodeTransport } from "../sealFormat.js";
import { scanQrImage } from "./scanQrImage.js";
import { qredPayloadFromScanResult } from "./qrPayload.js";
import { qrPayloadBytes } from "../sealFormat.js";

const MAX_PIXELS = 3_000_000, MAX_CANDIDATES = 64, MAX_CROP_PIXELS = 4_000_000;
// Pixel-only proposal stage. No signed wording, symbol positions, or payloads
// enter discovery. Original pixels are never changed or supplied to OCR here.
export function erasureCandidates({ data, width, height }) {
  const pixels = width * height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      pixels > MAX_PIXELS || data?.length !== pixels * 4) return [];
  const horizontal = new Uint8Array(pixels), occupied = new Uint8Array(pixels);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let dx = -2; dx <= 2; dx++) {
    const xx = x + dx;
    if (xx < 0 || xx >= width) continue;
    const at = (y * width + xx) * 4;
    if (Math.min(data[at], data[at + 1], data[at + 2]) < 235) { horizontal[y * width + x] = 1; break; }
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let dy = -2; dy <= 2; dy++) {
    const yy = y + dy;
    if (yy >= 0 && yy < height && horizontal[yy * width + x]) { occupied[y * width + x] = 1; break; }
  }
  const queue = new Uint32Array(pixels), boxes = [];
  for (let startPixel = 0; startPixel < pixels; startPixel++) if (occupied[startPixel]) {
    let start = 0, end = 1, minX = startPixel % width, maxX = minX, minY = Math.floor(startPixel / width), maxY = minY;
    queue[0] = startPixel; occupied[startPixel] = 0;
    while (start < end) {
      const p = queue[start++], x = p % width, y = Math.floor(p / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const next of [x > 0 ? p - 1 : -1, x + 1 < width ? p + 1 : -1, y > 0 ? p - width : -1, y + 1 < height ? p + width : -1]) {
        if (next >= 0 && occupied[next]) { occupied[next] = 0; queue[end++] = next; }
      }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    if (w <= 50 || h <= 50 || w >= 400 || h >= 400 || w / h <= .8 || w / h >= 1.2) continue;
    const x = Math.max(0, minX - 12), y = Math.max(0, minY - 12);
    boxes.push({ x, y, width: Math.min(width, maxX + 13) - x, height: Math.min(height, maxY + 13) - y });
    if (boxes.length > MAX_CANDIDATES) return []; // No partial “success” after a hostile candidate flood.
  }
  return boxes;
}
function cropContrast(image, box) {
  const data = new Uint8ClampedArray(box.width * box.height * 4), histogram = new Uint32Array(256);
  for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) {
    const source = ((box.y + y) * image.width + box.x + x) * 4, target = (y * box.width + x) * 4;
    const gray = Math.round((image.data[source] + image.data[source + 1] + image.data[source + 2]) / 3);
    data[target] = data[target + 1] = data[target + 2] = gray; data[target + 3] = 255; histogram[gray]++;
  }
  const count = data.length / 4;
  let sum = 0, low = 0, high = 255;
  for (let i = 0; i < 256; i++) { sum += histogram[i]; if (sum >= count * .1) { low = i; break; } }
  sum = 0;
  for (let i = 0; i < 256; i++) { sum += histogram[i]; if (sum >= count * .9) { high = i; break; } }
  for (let at = 0; at < data.length; at += 4) {
    const gray = Math.max(0, Math.min(255, (data[at] - low) * 255 / Math.max(1, high - low)));
    data[at] = data[at + 1] = data[at + 2] = gray;
  }
  return data;
}
export async function scanErasureSeals(image, { signal } = {}) {
  signal?.throwIfAborted();
  const boxes = erasureCandidates(image), values = new Set();
  if (boxes.reduce((sum, b) => sum + b.width * b.height, 0) > MAX_CROP_PIXELS) return [];
  for (const box of boxes) {
    await new Promise(resolve => setTimeout(resolve, 0)); signal?.throwIfAborted();
    const value = qredPayloadFromScanResult(scanQrImage(cropContrast(image, box), box.width, box.height,
      { tryWatermark: false, tryRescaling: true, maxAttempts: 4 }));
    if (!value) continue;
    try { if (decodeTransport(qrPayloadBytes(value)).erasure) values.add(value); } catch { /* Not a transport shard. */ }
  }
  return [...values];
}
