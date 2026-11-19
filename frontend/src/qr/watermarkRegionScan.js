// Find compact pale print and reuse the native-pixel reader for each quadrant.
// These are optical hypotheses only. Payload parsing and signatures remain in
// the normal decoder/session; no original PDF, known text or key locates a seal.
import { normalizeWatermarkLuminance, isChromaticForeground } from "./watermarkFilter.js";
import { previewForPaperEdges } from "./paperGeometryPreview.js";
import { estimatePaperColor } from "./paperColor.js";
import { locatePaper, pageHomography, pageWatermarkRegions } from "./pageAlignedScan.js";
import { createRectifiedSealScanner } from "./rectifiedSealScan.js";
import { scanQrImage } from "./scanQrImage.js";
import { qredPayloadFromScanResult } from "./qrPayload.js";

export function paleWatermarkRegions(source, { shouldContinue = () => true } = {}) {
  if (!shouldContinue()) return [];
  const image = previewForPaperEdges(source), { data, width, height } = image;
  if (!shouldContinue()) return [];
  const gray = normalizeWatermarkLuminance(data, width, height), color = estimatePaperColor(image);
  const step = Math.max(8, Math.ceil(Math.max(width, height) / 100));
  const columns = Math.ceil(width / step), rows = Math.ceil(height / step);
  const occupied = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    if (!shouldContinue()) return [];
    for (let col = 0; col < columns; col++) {
      let ink = 0, paper = 0, count = 0;
      for (let y = row * step; y < Math.min(height, (row + 1) * step); y += 2)
        for (let x = col * step; x < Math.min(width, (col + 1) * step); x += 2) {
          const at = y * width + x, value = gray[at];
          count++;
          if (isChromaticForeground(data, at * 4, color)) continue;
          ink += Number(value >= 180 && value < 240);
          paper += Number(value >= 245);
        }
      // Dense mixed pale/white cells distinguish a watermark patch from a
      // solid fill, a long table rule or sparse dark text.
      occupied[row * columns + col] = Number(ink > count * .20 && paper > count * .15);
    }
  }
  const seen = new Uint8Array(occupied.length), regions = [];
  for (let start = 0; start < occupied.length; start++) {
    if (!occupied[start] || seen[start]) continue;
    if (!shouldContinue()) return [];
    const queue = [start]; seen[start] = 1;
    let left = columns, right = 0, top = rows, bottom = 0;
    for (let head = 0; head < queue.length; head++) {
      const at = queue[head], x = at % columns, y = Math.floor(at / columns);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const xx = x + dx, yy = y + dy, next = yy * columns + xx;
        if (xx >= 0 && yy >= 0 && xx < columns && yy < rows && occupied[next] && !seen[next]) {
          seen[next] = 1; queue.push(next);
        }
      }
    }
    const w = right - left + 1, h = bottom - top + 1;
    if (w < 6 || h < 6 || w / h < .5 || w / h > 2 ||
        w * h > columns * rows * .35 || queue.length < w * h * .6) continue;
    const x = Math.max(0, Math.floor((left - 2) * step * source.width / width));
    const y = Math.max(0, Math.floor((top - 2) * step * source.height / height));
    regions.push({ x, y,
      width: Math.min(source.width, Math.ceil((right + 3) * step * source.width / width)) - x,
      height: Math.min(source.height, Math.ceil((bottom + 3) * step * source.height / height)) - y });
  }
  return regions.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 4);
}

function readPatch(image, box, shouldContinue) {
  // Candidate discovery uses a preview; decoding keeps the source detail up
  // to the existing 2.5 MP watermark limit, with geometry mapped back below.
  const scale = Math.max(1, Math.ceil(Math.sqrt(box.width * box.height / 2_500_000)));
  const width = Math.ceil(box.width / scale), height = Math.ceil(box.height / scale);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (!shouldContinue()) return null;
    for (let x = 0; x < width; x++) {
      const at = ((box.y + y * scale) * image.width + box.x + x * scale) * 4;
      data.set(image.data.subarray(at, at + 4), (y * width + x) * 4);
    }
  }
  const code = scanQrImage(data, width, height,
    { tryRescaling: false, maxAttempts: 3, shouldContinue });
  const seal = qredPayloadFromScanResult(code);
  if (!seal) return null;
  return { seal, code: { ...code, location: code.location && Object.fromEntries(
    Object.entries(code.location).map(([key, p]) => [key, { x: box.x + p.x * scale, y: box.y + p.y * scale }])) } };
}

export function scanWatermarkRegions(image, { pageMapping = null, shouldContinue = () => true, onSeal } = {}) {
  const results = [], seen = new Set();
  const keep = result => {
    if (!result || seen.has(result.seal)) return;
    seen.add(result.seal); results.push(result); onSeal?.(result.seal);
  };
  for (const box of paleWatermarkRegions(image, { shouldContinue })) {
    if (!shouldContinue()) return results;
    keep(readPatch(image, box, shouldContinue));
  }
  if (!shouldContinue()) return results;
  if (!pageMapping) {
    const quad = locatePaper(image);
    pageMapping = quad && pageHomography(quad);
  }
  if (!pageMapping) return results;
  // Each quadrant has its own measured finders, version, alignment marks and
  // local bend. Reuse the same reader as a whole-page seal, at both established
  // print scales. The caller bounds this entire pass and checkpoints each part.
  for (const profile of [{ marginPoints: 54 }, { marginPoints: 36 }, { legacy: true }]) {
    for (const scale of [1, .97]) {
      const mapping = scale === 1 ? pageMapping :
        (u, v) => pageMapping(.5 + (u - .5) * scale, .5 + (v - .5) * scale);
      for (const region of pageWatermarkRegions(4, undefined, profile)) {
        if (!shouldContinue()) return results;
        keep(createRectifiedSealScanner(image, { pageMapping: mapping, regions: [region] })({
          searchRadius: 12, shouldContinue,
        }));
      }
    }
  }
  return results;
}
