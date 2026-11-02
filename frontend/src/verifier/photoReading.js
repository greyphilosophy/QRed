import { preparePhotoReadingInWorker } from "../qr/photoScanClient.js";
import { comparePhotoText } from "./photoTextComparison.js";

// This is a second reading, never a replacement for the displayed original.
// Removing a pale watermark can also remove pale writing: a result using this
// copy must always require visual review, even when its dark text agrees.
export async function preparePhotoReading(source, { signal } = {}) {
  signal?.throwIfAborted();
  const pixels = source.getContext("2d").getImageData(0, 0, source.width, source.height);
  const { image, codes } = await preparePhotoReadingInWorker(pixels, { signal });
  const canvas = document.createElement("canvas");
  canvas.width = image.width; canvas.height = image.height;
  try {
    if (signal?.aborted) throw new DOMException("Reading cancelled", "AbortError");
    canvas.getContext("2d", { willReadFrequently: true }).putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    return { canvas, codes };
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
  return box && box.y1 - box.y0 < size * .3 && box.x0 >= code.x0 - size && box.x1 <= code.x1 + size &&
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

export function possiblePrintedMarkings(words, codes) {
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
    for (let index = 0; index < words.length - 2; index++) {
      const phrase = words.slice(index, index + 3);
      if (!isPrintedCaption(phrase)) continue;
      const near = phrase.every(word => nearCaption(word.bbox, box));
      if (near && ![index, index + 1, index + 2].some(i => used.has(i))) {
        groups.push([index, index + 1, index + 2]);
        [index, index + 1, index + 2].forEach(i => used.add(i));
      }
    }
  }
  return groups;
}

export function comparePageReading(expected, reading, dimensions) {
  const { words, codes = [], contrastAssisted = false } = Array.isArray(reading) ? { words: reading } : reading;
  let comparison = comparePhotoText(expected, words, dimensions);
  const groups = possiblePrintedMarkings(words, codes).filter(indices => indices.every(index =>
    comparison.words.find(word => word.sourceIndex === index)?.agrees === false));
  const excluded = new Set(groups.flat());
  if (excluded.size) comparison = comparePhotoText(expected, words.filter((_, index) => !excluded.has(index)), dimensions);
  const markings = groups.map(indices => ({ observed: indices.map(index => words[index].text).join(" "),
    boxes: indices.map(index => words[index].bbox) }));
  if (comparison.status === "matches" && (contrastAssisted || markings.length)) comparison.status = "uncertain";
  return { ...comparison, contrastAssisted, markings };
}
