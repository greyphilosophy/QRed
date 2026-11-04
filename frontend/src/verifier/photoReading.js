import { preparePhotoReadingInWorker } from "../qr/photoScanClient.js";
import { compareLocatedPhotoText, signedPhotoLines } from "./photoTextLayout.js";

// This is a second reading, never a replacement for the displayed original.
// Removing a pale watermark can also remove pale writing: a result using this
// copy must always require visual review, even when its dark text agrees.
export async function preparePhotoReading(source, { signal } = {}) {
  signal?.throwIfAborted();
  const pixels = source.getContext("2d").getImageData(0, 0, source.width, source.height);
  const { image, codes, corners } = await preparePhotoReadingInWorker(pixels, { signal });
  const canvas = document.createElement("canvas");
  canvas.width = image.width; canvas.height = image.height;
  try {
    if (signal?.aborted) throw new DOMException("Reading cancelled", "AbortError");
    canvas.getContext("2d", { willReadFrequently: true }).putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    return { canvas, codes, corners };
  } catch (error) {
    canvas.width = canvas.height = 0;
    throw error;
  } finally { image.data.fill(0); }
}

// Only identify the caption beside a decoded QRed code. Allow the observed q/g
// OCR ambiguity, but never correct it: the original spelling and crop remain
// visible for review. The same phrase elsewhere and extra words stay in the diff.
export const isPrintedCaption = words => /^Verify at [qg]red\.org$/.test(words.map(word => word.text).join(" "));
function nearCaption(box, code) {
  const size = Math.max(code.x1 - code.x0, code.y1 - code.y0);
  // The half-inch navigation QR has a 16–18px caption at the usual raster scale.
  // Geometry alone never excludes words: the exact caption must still be read.
  return box && box.y1 - box.y0 <= size * .4 && box.x0 >= code.x0 - size && box.x1 <= code.x1 + size &&
    ((box.y0 >= code.y1 && box.y1 < code.y1 + size * .7) || (box.y1 <= code.y0 && box.y0 > code.y0 - size * .7) ||
      (box.x0 >= code.x1 && box.x1 < code.x1 + size && box.y0 >= code.y0 && box.y1 <= code.y1));
}

// A full-page OCR pass can mistake a tiny caption for vertical text. Find small
// nearby lines for an independent enlarged read, without supplying expected text.
export function captionLineCandidates(words, codes) {
  const lines = [], used = new Set();
  for (const code of codes) for (let index = 0; index < words.length; index++) {
    if (used.has(index) || !nearCaption(words[index].bbox, code)) continue;
    const first = words[index].bbox, center = (first.y0 + first.y1) / 2;
    const indices = words.flatMap((word, i) => !used.has(i) && nearCaption(word.bbox, code) &&
      Math.abs((word.bbox.y0 + word.bbox.y1) / 2 - center) < Math.max(first.y1 - first.y0, word.bbox.y1 - word.bbox.y0) * .6 ? [i] : []);
    indices.forEach(i => used.add(i));
    const ordered = [...indices].sort((a, b) => words[a].bbox.x0 - words[b].bbox.x0);
    if (isPrintedCaption(ordered.map(i => words[i]))) continue;
    const boxes = indices.map(i => words[i].bbox);
    lines.push({ indices, x0: Math.min(...boxes.map(b => b.x0)), y0: Math.min(...boxes.map(b => b.y0)),
      x1: Math.max(...boxes.map(b => b.x1)), y1: Math.max(...boxes.map(b => b.y1)) });
    if (lines.length === 8) return lines;
  }
  return lines;
}

// Older first-page navigation panels had corner brackets. OCR can join those
// strokes to the URL, or split/join the caption words. Match only the fixed
// caption characters at the original positions beside a decoded navigation
// link. Never exempt a whole panel or arbitrary trailing text.
function navigationCaption(words, index, code, pageNumber) {
  if (pageNumber !== 1 || code.kind !== "navigation") return null;
  const size = Math.max(code.x1 - code.x0, code.y1 - code.y0);
  for (let count = 1; count <= 3 && index + count <= words.length; count++) {
    const phrase = words.slice(index, index + count);
    const compact = phrase.map(word => word.text).join("").replace(/\s/gu, "");
    if (!/^\|?Verifyat[qg]red\.org(?:_[|J])?$/.test(compact)
        || !phrase.every(word => nearCaption(word.bbox, code))) continue;
    const first = phrase[0].bbox, last = phrase.at(-1).bbox;
    const hasBracket = /_[|J]$/.test(compact), hasPrefix = compact.startsWith("|");
    // Joined punctuation must reach the actual corner, not merely occur
    // anywhere near the QR. Caption words must share the expected baseline.
    if (phrase.some(word => Math.abs(word.bbox.y0 - first.y0) > size * .12)
        || first.y0 < code.y1 + size * .15 || first.y0 > code.y1 + size * .5
        || (hasBracket && (last.x1 < code.x1 + size * .55 || last.x1 > code.x1 + size * .95))
        || (hasPrefix && (first.x0 < code.x0 - size * .95 || first.x0 > code.x0 - size * .55))) continue;
    const indices = phrase.map((_, offset) => index + offset), before = words[index - 1];
    if (!hasPrefix && before?.text === "|" && nearCaption(before.bbox, code)
        && before.bbox.x0 >= code.x0 - size * .95 && before.bbox.x1 <= code.x0 - size * .55
        && Math.abs(before.bbox.y0 - first.y0) <= size * .12) indices.unshift(index - 1);
    return indices;
  }
  return null;
}

export function possiblePrintedMarkings(words, codes, { pageNumber } = {}) {
  const groups = [], used = new Set();
  for (const box of codes) {
    const inside = words.flatMap((word, index) => {
      const b = word.bbox;
      if (!b || used.has(index)) return [];
      // OCR boxes around QR glyphs can overshoot the ink. Require their center
      // and most of their area inside the code, never an expanding outside band.
      const x = (b.x0 + b.x1) / 2, y = (b.y0 + b.y1) / 2;
      const overlap = Math.max(0, Math.min(b.x1, box.x1) - Math.max(b.x0, box.x0)) *
        Math.max(0, Math.min(b.y1, box.y1) - Math.max(b.y0, box.y0));
      return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 &&
        overlap >= (b.x1 - b.x0) * (b.y1 - b.y0) * .5 ? [index] : [];
    });
    if (inside.length) { groups.push(inside); inside.forEach(index => used.add(index)); }
    for (let index = 0; index < words.length; index++) {
      const phrase = words.slice(index, index + 3);
      const navigation = navigationCaption(words, index, box, pageNumber);
      const indices = navigation || (phrase.length === 3 && isPrintedCaption(phrase) && phrase.every(word => nearCaption(word.bbox, box))
        ? [index, index + 1, index + 2] : null);
      if (indices && !indices.some(i => used.has(i))) {
        groups.push(indices);
        indices.forEach(i => used.add(i));
      }
    }
  }
  return groups;
}

export function comparePageReading(expected, reading, dimensions, evidence, options = {}) {
  const { words, codes = [], contrastAssisted = false, corners, retryReviews = [] } = Array.isArray(reading) ? { words: reading } : reading;
  const lines = signedPhotoLines(expected, evidence, corners, dimensions, words);
  const compare = input => compareLocatedPhotoText(expected, input, dimensions, lines);
  let comparison = compare(words);
  const groups = possiblePrintedMarkings(words, codes, options).filter(indices => indices.every(index =>
    comparison.words.find(word => word.sourceIndex === index)?.agrees === false));
  const excluded = new Set(groups.flat());
  if (excluded.size) {
    const indices = words.flatMap((_, index) => excluded.has(index) ? [] : [index]);
    comparison = compare(indices.map(index => words[index]));
    comparison.words = comparison.words.map(word => ({ ...word, sourceIndex: indices[word.sourceIndex] }));
    comparison.differences = comparison.differences.map(difference => ({ ...difference,
      wordIndices: difference.wordIndices.map(index => indices[index]),
    }));
  }
  const markings = groups.map(indices => ({ observed: indices.map(index => words[index].text).join(" "),
    boxes: indices.map(index => words[index].bbox) }));
  if (comparison.status === "matches" && (contrastAssisted || markings.length || retryReviews.length)) comparison.status = "uncertain";
  return { ...comparison, contrastAssisted, markings, retryReviews };
}
