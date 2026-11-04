import { assignPhotoLines, enclosingBox } from "./photoTextLayout.js";
import { OCR_REVIEW_THRESHOLD } from "./photoTextComparison.js";

export const MAX_TEXT_RETRIES = 12;
export const TEXT_RETRY_PIXELS = 2_500_000;
export const TEXT_RETRY_MS = 3000; // Cooperative: finish an in-flight crop, then stop.

export function planTextRetries(words, comparison, signedLines, { width, height }) {
  const questioned = new Set(comparison.words.filter(word => word.status !== "matched").map(word => word.sourceIndex));
  const groups = signedLines ? assignPhotoLines(signedLines, words) : [];
  const grouped = new Set(groups.flatMap(line => line.wordIndices));
  const observed = new Map();
  words.forEach((word, index) => {
    if (grouped.has(index) || !word.bbox) return;
    // Keep engine line structure instead of joining separate columns.
    const key = word.lineId ?? `word-${index}`;
    if (!observed.has(key)) observed.set(key, []);
    observed.get(key).push(index);
  });
  for (const indices of observed.values()) groups.push({ wordIndices: indices,
    bbox: enclosingBox(indices.map(index => words[index].bbox)) });
  const candidates = [];
  const missingBoxes = comparison.differences.filter(difference => difference.expected && !difference.observed)
    .flatMap(difference => difference.boxes || []);
  for (const group of groups) {
    const missing = group.text && (group.wordIndices.length === 0 || missingBoxes.some(box =>
      ["x0", "y0", "x1", "y1"].every(key => box[key] === group.bbox?.[key])));
    if (!missing && !group.wordIndices.some(index => questioned.has(index))) continue;
    const base = enclosingBox([group.bbox, ...group.wordIndices.map(index => words[index].bbox)].filter(Boolean));
    if (!base) continue;
    const pad = Math.max(4, (base.y1 - base.y0) * .15);
    const box = { x0: Math.max(0, Math.floor(base.x0 - pad)), y0: Math.max(0, Math.floor(base.y0 - pad)),
      x1: Math.min(width, Math.ceil(base.x1 + pad)), y1: Math.min(height, Math.ceil(base.y1 + pad)) };
    // Padding must not bring in strips of a neighboring line. Checking only
    // word centers misses these clipped glyphs, which single-line OCR can
    // hallucinate as extra punctuation. Trim padding, never signed content.
    for (const word of words) {
      const b = word.bbox;
      if (!b || b.x1 <= box.x0 || b.x0 >= box.x1 || b.y1 <= box.y0 || b.y0 >= box.y1) continue;
      if (b.y1 <= base.y0) box.y0 = Math.max(box.y0, b.y1);
      else if (b.y0 >= base.y1) box.y1 = Math.min(box.y1, b.y0);
      else if (b.x1 <= base.x0) box.x0 = Math.max(box.x0, b.x1);
      else if (b.x0 >= base.x1) box.x1 = Math.min(box.x1, b.x0);
    }
    if (box.x1 <= box.x0 || box.y1 <= box.y0 || box.y1 - box.y0 > height * .15) continue;
    // Include additions inside the crop; never replace partly cropped words.
    const indices = words.flatMap((word, index) => {
      const b = word.bbox;
      return b && (b.x0 + b.x1) / 2 >= box.x0 && (b.x0 + b.x1) / 2 <= box.x1
        && (b.y0 + b.y1) / 2 >= box.y0 && (b.y0 + b.y1) / 2 <= box.y1 ? [index] : [];
    });
    if (words.some(word => {
      const b = word.bbox;
      return b && b.x1 > box.x0 && b.x0 < box.x1 && b.y1 > box.y0 && b.y0 < box.y1
        && (b.x0 < box.x0 || b.x1 > box.x1 || b.y0 < box.y0 || b.y1 > box.y1);
    })) continue;
    const priority = missing ? 0 : indices.some(index => comparison.words.find(w => w.sourceIndex === index)?.agrees === false) ? 1 : 2;
    candidates.push({ bbox: box, indices, priority });
  }
  const selected = [];
  for (const candidate of candidates.sort((a, b) => a.priority - b.priority)) {
    if (selected.some(other => Math.min(other.bbox.x1, candidate.bbox.x1) > Math.max(other.bbox.x0, candidate.bbox.x0)
      && Math.min(other.bbox.y1, candidate.bbox.y1) > Math.max(other.bbox.y0, candidate.bbox.y0))) continue;
    selected.push(candidate);
    if (selected.length === MAX_TEXT_RETRIES) break;
  }
  return selected;
}

function quality(words) {
  let weight = 0, confidence = 0;
  for (const word of words) {
    const size = String(word.text || "").replace(/\s/gu, "").length;
    weight += size; confidence += size * (Number.isFinite(word.confidence) ? word.confidence : 0);
  }
  return { size: weight, confidence: weight ? confidence / weight : 0 };
}

// No signed text enters this decision. Contradictory originals stay visible.
export function preferTextRetry(before, after) {
  if (!after.length || after.length > 120 || after.some(word => !word.bbox)) return false;
  // A row's mean confidence can hide a newly hallucinated punctuation token.
  // Require independent confidence for new tokens rather than letting long,
  // unchanged words outvote them. Existing uncertain readings stay visible.
  const remaining = new Map();
  for (const word of before) {
    const token = String(word.text || "").normalize("NFC");
    remaining.set(token, (remaining.get(token) || 0) + 1);
  }
  for (const word of after) {
    const token = String(word.text || "").normalize("NFC"), count = remaining.get(token) || 0;
    if (count) remaining.set(token, count - 1);
    else if (!Number.isFinite(word.confidence) || word.confidence < OCR_REVIEW_THRESHOLD) return false;
  }
  const oldQuality = quality(before), nextQuality = quality(after);
  const original = [...before.map(word => word.text).join("").normalize("NFC").replace(/\s/gu, "")];
  const observed = after.map(word => word.text).join("").normalize("NFC").replace(/\s/gu, "");
  let retained = 0;
  for (const character of observed) if (character === original[retained]) retained++;
  // A confident first pass can still omit a whole numeric column. Accept a
  // confident, more complete reading that retains every original character,
  // without consulting what the signed page says the missing text should be.
  const moreComplete = nextQuality.size > oldQuality.size && retained === original.length;
  return nextQuality.confidence >= OCR_REVIEW_THRESHOLD && nextQuality.size >= oldQuality.size * .6
    && (!before.length || moreComplete || nextQuality.confidence >= oldQuality.confidence + 3);
}

export function applyTextRetries(words, replacements) {
  const removed = new Set(), inserts = new Map(), extra = [], retryReviews = [];
  for (const { candidate, words: reading } of replacements) {
    const before = candidate.indices.map(index => words[index]);
    if (!preferTextRetry(before, reading)) continue;
    const original = before.map(word => word.text).join(" ");
    const observed = reading.map(word => word.text).join(" ");
    if (original && original.normalize("NFC") !== observed.normalize("NFC"))
      retryReviews.push({ original, observed, boxes: [candidate.bbox] });
    candidate.indices.forEach(index => removed.add(index));
    if (candidate.indices.length) inserts.set(Math.min(...candidate.indices), reading);
    else extra.push(...reading);
  }
  return { words: [...words.flatMap((word, index) => inserts.get(index) || (removed.has(index) ? [] : [word])), ...extra], retryReviews };
}
