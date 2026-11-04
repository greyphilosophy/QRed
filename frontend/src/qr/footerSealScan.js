// Locate compact regions of dark print before QR decoding. Adjacent footer
// codes can confuse a whole-frame finder triple. This is only an optical
// candidate generator; payload parsing and signatures remain authoritative.
import { scanQrImage } from "./scanQrImage.js";
import { qredPayloadFromScanResult } from "./qrPayload.js";

export function footerQrRegions(image, { shouldContinue = () => true } = {}) {
  const { data, width, height } = image;
  const step = Math.max(8, Math.ceil(Math.max(width, height) / 160));
  const cols = Math.ceil(width / step), rows = Math.ceil(height / step);
  const occupied = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    if (!shouldContinue()) return [];
    for (let col = 0; col < cols; col++) {
      let dark = 0, count = 0;
      for (let y = row * step; y < Math.min(height, (row + 1) * step); y += 2)
        for (let x = col * step; x < Math.min(width, (col + 1) * step); x += 2) {
          const i = (y * width + x) * 4;
          dark += Number(Math.max(data[i], data[i + 1], data[i + 2]) < 120); count++;
        }
      occupied[row * cols + col] = Number(dark > count * 0.25);
    }
  }
  const seen = new Uint8Array(occupied.length), regions = [];
  for (let start = 0; start < occupied.length; start++) {
    if (!occupied[start] || seen[start]) continue;
    if (!shouldContinue()) return [];
    const queue = [start]; seen[start] = 1;
    let left = cols, right = 0, top = rows, bottom = 0;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head], x = i % cols, y = Math.floor(i / cols);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const xx = x + dx, yy = y + dy, j = yy * cols + xx;
        if (xx >= 0 && yy >= 0 && xx < cols && yy < rows && occupied[j] && !seen[j]) {
          seen[j] = 1; queue.push(j);
        }
      }
    }
    const w = right - left + 1, h = bottom - top + 1;
    if (w * h > cols * rows * 0.45 || w < 6 || h < 6 || w / h < 0.6 || w / h > 1.7 || queue.length / (w * h) < 0.6) continue;
    const x = Math.max(0, (left - 2) * step), y = Math.max(0, (top - 2) * step);
    regions.push({ x, y, width: Math.min(width, (right + 3) * step) - x,
      height: Math.min(height, (bottom + 3) * step) - y });
  }
  return regions.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 8);
}

export function scanFooterSeals(image, { shouldContinue = () => true } = {}) {
  if (!shouldContinue()) return [];
  const codes = [], found = new Set();
  for (const box of footerQrRegions(image, { shouldContinue })) {
    if (!shouldContinue()) break;
    // Keep the working crop bounded even for a 48 MP upload. Candidate
    // detection and retained evidence always use the original photograph.
    const scale = Math.max(1, Math.ceil(Math.sqrt(box.width * box.height / 2_500_000)));
    const width = Math.ceil(box.width / scale), height = Math.ceil(box.height / scale);
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      if (!shouldContinue()) return codes;
      for (let x = 0; x < width; x++) {
        const offset = ((box.y + y * scale) * image.width + box.x + x * scale) * 4;
        data.set(image.data.subarray(offset, offset + 4), (y * width + x) * 4);
      }
    }
    const code = scanQrImage(data, width, height,
      { tryWatermark: false, maxAttempts: 4, shouldContinue });
    const payload = qredPayloadFromScanResult(code);
    if (!payload || found.has(payload)) continue;
    found.add(payload);
    codes.push({ ...code, location: code.location && Object.fromEntries(
      Object.entries(code.location).map(([key, point]) => [key, { x: point.x * scale + box.x, y: point.y * scale + box.y }])) });
  }
  return codes;
}
