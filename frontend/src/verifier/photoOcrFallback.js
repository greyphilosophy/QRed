import { OCR_REVIEW_THRESHOLD } from "./photoTextComparison.js";

function quality(words) {
  let characters = 0, reliable = 0, total = 0;
  for (const word of words) {
    const size = String(word.text || "").replace(/\s/gu, "").length;
    const confidence = Number.isFinite(word.confidence) ? Math.max(0, Math.min(100, word.confidence)) : 0;
    characters += size; total += size * confidence;
    if (confidence >= OCR_REVIEW_THRESHOLD) reliable += size;
  }
  return { characters, reliable, confidence: characters ? total / characters : 0 };
}

// Decide from recognition quality only. Signed wording must never choose the
// reading. Even a better second reading can miss pale additions: retain the
// first reading and require review whenever this fallback is selected.
export function needsPageReread(words) {
  if (words.length < 5 || words.length > 4000) return false;
  const q = quality(words);
  return q.characters > 0 && q.reliable < q.characters * .8;
}

export function preferPageReread(before, after) {
  if (!after.length || after.length > 4000) return false;
  const old = quality(before), next = quality(after);
  return next.characters >= old.characters * .6 && next.reliable >= old.reliable
    && next.confidence >= old.confidence + 5;
}

// A second reading can omit the surrounding desk once four measured edges
// exist. Keep native coordinates and all paper pixels; never use signed text
// boxes to mask a page. The first, uncropped reading remains available.
export function pageReadingCanvas(source, corners) {
  if (corners?.length !== 4 || corners.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)
    || p.x < 0 || p.y < 0 || p.x > source.width || p.y > source.height)) return null;
  const area = corners.reduce((sum, p, i) => {
    const next = corners[(i + 1) % 4];
    return sum + p.x * next.y - next.x * p.y;
  }, 0) / 2;
  if (area < source.width * source.height * .5) return null;
  const canvas = document.createElement("canvas");
  canvas.width = source.width; canvas.height = source.height;
  const context = canvas.getContext("2d");
  context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.beginPath();
  corners.forEach((p, i) => i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y));
  context.closePath(); context.clip(); context.drawImage(source, 0, 0);
  return canvas;
}
