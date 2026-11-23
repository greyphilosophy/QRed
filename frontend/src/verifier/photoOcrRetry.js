import { assignPhotoLines, enclosingBox, indicesInsidePhotoCrop } from "./photoTextLayout.js";
import { comparePhotoText, OCR_REVIEW_THRESHOLD } from "./photoTextComparison.js";
import { disputedDateFields, isDateReading } from "./photoDateField.js";

export const MAX_TEXT_RETRIES = 12;
export const TEXT_RETRY_PIXELS = 2_500_000;
export const TEXT_RETRY_MS = 3000; // Cooperative: finish an in-flight crop, then stop.

export function planTextRetries(words, comparison, signedLines, { width, height }) {
  const questioned = new Set(comparison.words.filter(word => word.status !== "matched").map(word => word.sourceIndex));
  const disputedNumbers = new Set(comparison.differences.filter(difference => /\d/u.test(difference.expected))
    .flatMap(difference => difference.wordIndices));
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
  groups.unshift(...disputedDateFields(words, comparison.differences));
  // The signed row can brush a neighboring row although the disputed value
  // itself is isolated. Try its photographed word box if the full row fails.
  for (const d of comparison.differences) {
    if (!/^:\s*\d/u.test(d.expected) || d.wordIndices.length !== 1) continue;
    const first = words[d.wordIndices[0]];
    if (first?.bbox && first.confidence < OCR_REVIEW_THRESHOLD) groups.push({
      text: d.expected, wordIndices: d.wordIndices, bbox: first.bbox, separatedValue: true });
  }
  const candidates = [];
  const missingBoxes = comparison.differences.filter(difference => difference.expected && !difference.observed)
    .flatMap(difference => difference.boxes || []);
  for (const group of groups) {
    const missing = group.text && (group.wordIndices.length === 0 || missingBoxes.some(box =>
      ["x0", "y0", "x1", "y1"].every(key => box[key] === group.bbox?.[key])));
    if (!missing && !group.wordIndices.some(index => questioned.has(index))) continue;
    const base = enclosingBox([group.bbox, ...group.wordIndices.map(index => words[index].bbox)].filter(Boolean));
    if (!base) continue;
    const h = base.y1 - base.y0, pad = Math.max(4, h * .15);
    const px = group.dateField ? Math.max(1, Math.round(h * .23)) : pad;
    const py = group.dateField ? Math.max(1, Math.round(h * .18)) : pad;
    const box = { x0: Math.max(0, Math.floor(base.x0 - px)), y0: Math.max(0, Math.floor(base.y0 - py)),
      x1: Math.min(width, Math.ceil(base.x1 + px)), y1: Math.min(height, Math.ceil(base.y1 + py)) };
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
    const indices = indicesInsidePhotoCrop(words, box);
    if (!indices) continue;
    if (group.dateField) {
      if (indices.length === 1 && indices[0] === group.wordIndices[0])
        candidates.push({ bbox: box, indices, priority: -1, dateField: true, signedDate: group.signedDate });
      continue;
    }
    const priority = indices.some(index => disputedNumbers.has(index)) ? 0 : missing ? 1
      : indices.some(index => comparison.words.find(w => w.sourceIndex === index)?.agrees === false) ? 2 : 3;
    const sameLine = group.text && indices.length === group.wordIndices.length && indices.every(i => group.wordIndices.includes(i));
    if (group.separatedValue && !sameLine) continue;
    candidates.push({ bbox: box, indices, priority, signedLine: Boolean(group.text), signedText: sameLine ? group.text : undefined,
      ...(group.separatedValue ? { separatedValue: true } : {}) });
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

// Select the better OCR reading before comparing it with any signed wording.
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
  // A measured but unread separator is still present beside the closer words.
  const charactersRead = nextQuality.size + (after[0]?.precedingSeparatorBox ? 1 : 0);
  return nextQuality.confidence >= OCR_REVIEW_THRESHOLD && charactersRead >= oldQuality.size * .6
    && (!before.length || moreComplete || nextQuality.confidence >= oldQuality.confidence + 3);
}

// A noisy label can disqualify a whole-row reread while a separate numeric
// column is clear. Anchor the row in both readings and keep the original
// words. Neither the signed value nor similarity to it selects the number.
function omittedNumericFields(before, reading, candidate) {
  if (!candidate.signedLine || !before.length || before.some(word => !word.bbox) || reading.length > 120 ||
      reading.some(word => !word.bbox)) return [];
  const anchors = before.filter(a => a.confidence >= OCR_REVIEW_THRESHOLD &&
    reading.some(b => b.confidence >= OCR_REVIEW_THRESHOLD && b.text === a.text &&
      a.bbox.x0 < b.bbox.x1 && a.bbox.x1 > b.bbox.x0 && a.bbox.y0 < b.bbox.y1 && a.bbox.y1 > b.bbox.y0));
  if (!anchors.length) return [];
  return reading.filter(word => {
    const b = word.bbox, crop = candidate.bbox;
    if (!(word.confidence >= OCR_REVIEW_THRESHOLD) || !/^[-+]?\d+(?:[.,/-]\d+)*%?$/u.test(word.text) ||
        b.x0 < crop.x0 || b.y0 < crop.y0 || b.x1 > crop.x1 || b.y1 > crop.y1 ||
        !anchors.some(a => b.y0 < a.bbox.y1 && b.y1 > a.bbox.y0)) return false;
    const gap = Math.max(4, b.y1 - b.y0);
    const neighbors = [...before, ...reading.filter(other => other !== word)];
    return !neighbors.some(other => b.y0 < other.bbox.y1 && b.y1 > other.bbox.y0 &&
      b.x0 < other.bbox.x1 + gap && b.x1 > other.bbox.x0 - gap);
  });
}

// A stronger threshold can erase a faint extra word. A crop only settles a
// first reading if all of its words are still accounted for at that location.
export function accountsForFirstReading(before, after) {
  return after.every(word => word.confidence >= OCR_REVIEW_THRESHOLD) && before.every(first =>
    after.some(second => {
      const a = first.bbox, b = second.bbox;
      return a && b && a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0 &&
        (first.confidence < OCR_REVIEW_THRESHOLD || first.text === second.text);
    }));
}

function settlesFirstReading(candidate, before, after, matchedPageWords) {
  if (candidate.dateField) return after.length === 1 && after[0].text === candidate.signedDate;
  // A value both passes read in the same place will still get its own
  // difference card. It does not make a corrected word elsewhere a conflict.
  const unchangedAtLocation = word => {
    const x = (word.bbox.x0 + word.bbox.x1) / 2, y = (word.bbox.y0 + word.bbox.y1) / 2;
    return before.some(first => first.text === word.text && first.bbox &&
      first.bbox.x0 <= x && x < first.bbox.x1 && first.bbox.y0 <= y && y < first.bbox.y1);
  };
  if (!candidate.signedText) return !candidate.signedLine && matchedPageWords &&
    after.every(word => matchedPageWords.has(word) || unchangedAtLocation(word));
  const { differences } = comparePhotoText(candidate.signedText, after, { width: candidate.bbox.x1, height: candidate.bbox.y1 });
  return differences.every(d => d.observed ? d.wordIndices.every(i => unchangedAtLocation(after[i]))
    : /^\p{P}+$/u.test(d.expected));
}

export function applyTextRetries(words, replacements, compareWords) {
  const removed = new Set(), inserts = new Map(), extra = [], retryReviews = [], accepted = [];
  for (const { candidate, words: retry } of replacements) {
    let reading = retry;
    const before = candidate.indices.map(index => words[index]);
    const original = before.map(word => word.text).join(" ");
    let observed = reading.map(word => word.text).join(" ");
    const changed = original && original.normalize("NFC") !== observed.normalize("NFC");
    const wholeRowAccepted = preferTextRetry(before, reading);
    let conflict;
    if (candidate.dateField) {
      if (reading.length !== 1 || !isDateReading(observed)) continue;
      if (changed) {
        conflict = { dateField: true, signedDate: candidate.signedDate, original, observed, boxes: [candidate.bbox],
          lowConfidence: reading[0].confidence < OCR_REVIEW_THRESHOLD };
        if (!wholeRowAccepted || before[0].confidence >= OCR_REVIEW_THRESHOLD ||
          (original.replace(/\D/gu, "").length !== observed.replace(/\D/gu, "").length && observed !== candidate.signedDate)) {
          retryReviews.push(conflict);
          continue;
        }
      }
    }
    if (!wholeRowAccepted) {
      if (candidate.dateField) continue;
      const additions = omittedNumericFields(before, reading, candidate);
      if (!additions.length) continue;
      reading = [...before, ...additions].sort((a, b) => a.bbox.x0 - b.bbox.x0);
      observed = reading.map(word => word.text).join(" ");
    }
    if (changed) conflict ??= { original, observed, boxes: [candidate.bbox] };
    if (wholeRowAccepted && accountsForFirstReading(before, reading)) {
      accepted.push({ candidate, before, after: reading, conflict });
    } else if (conflict) retryReviews.push(conflict);
    candidate.indices.forEach(index => removed.add(index));
    if (candidate.indices.length) inserts.set(Math.min(...candidate.indices), reading);
    else extra.push(...reading);
  }
  const finalWords = [...words.flatMap((word, index) => inserts.get(index) || (removed.has(index) ? [] : [word])), ...extra];
  // Older seals can lack signed line boxes. In that case use the accepted
  // words' actual positions in the final page alignment, not a substring search.
  let matchedPageWords;
  if (compareWords && accepted.some(({ candidate }) => !candidate.signedText && !candidate.signedLine && !candidate.dateField)) {
    matchedPageWords = new Set(compareWords(finalWords).words.filter(word => word.status === "matched")
      .map(word => finalWords[word.sourceIndex]));
  }
  const resolvedCrops = [];
  for (const { candidate, before, after, conflict } of accepted) {
    if (settlesFirstReading(candidate, before, after, matchedPageWords)) resolvedCrops.push({ candidate, before, after });
    else if (conflict) retryReviews.push(conflict);
  }
  return { words: finalWords, retryReviews, resolvedCrops };
}
