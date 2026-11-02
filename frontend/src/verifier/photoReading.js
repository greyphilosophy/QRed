import jsQR from "jsqr";
import { maskQrCode } from "../qr/maskQrCode.js";
import { isQRedEntryLink, qredPayloadFromScanResult } from "../qr/qrPayload.js";
import { decodeSeal } from "../qredVerifier.js";
import { comparePhotoText } from "./photoTextComparison.js";

// This is a second reading, never a replacement for the displayed original.
// Removing a pale watermark can also remove pale writing: a result using this
// copy must always require visual review, even when its dark text agrees.
export function preparePhotoReading(source) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width; canvas.height = source.height;
  const context = canvas.getContext("2d");
  context.drawImage(source, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    if (Math.min(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]) > 150) {
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255;
    }
  }
  context.putImageData(pixels, 0, 0);
  const codes = [];
  try {
    for (let count = 0; count < 8; count++) {
      const code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "dontInvert" });
      if (!code) break;
      const text = qredPayloadFromScanResult(code) || code.data;
      const points = ["topLeftCorner", "topRightCorner", "bottomLeftCorner", "bottomRightCorner"].map(key => code.location[key]);
      const box = { x0: Math.min(...points.map(p => p.x)), y0: Math.min(...points.map(p => p.y)),
        x1: Math.max(...points.map(p => p.x)), y1: Math.max(...points.map(p => p.y)) };
      if ((isQRedEntryLink(text) || decodeSeal(text)) &&
          (box.x1 - box.x0) * (box.y1 - box.y0) < source.width * source.height * .2) codes.push(box);
      if (!maskQrCode(pixels.data, pixels.width, pixels.height, code)) break;
    }
    return { canvas, codes };
  } catch (error) {
    canvas.width = canvas.height = 0;
    throw error;
  } finally { pixels.data.fill(0); }
}

// Only identify the caption beside a decoded QRed code. Allow the observed q/g
// OCR ambiguity, but never correct it: the original spelling and crop remain
// visible for review. The same phrase elsewhere and extra words stay in the diff.
export function possiblePrintedMarkings(words, codes) {
  const groups = [], used = new Set();
  for (const box of codes) {
    const size = Math.max(box.x1 - box.x0, box.y1 - box.y0), margin = size * .2;
    const inside = words.flatMap((word, index) => {
      const b = word.bbox;
      return b && b.x0 >= box.x0 - margin && b.x1 <= box.x1 + margin &&
        b.y0 >= box.y0 - margin && b.y1 <= box.y1 + margin && !used.has(index) ? [index] : [];
    });
    if (inside.length) { groups.push(inside); inside.forEach(index => used.add(index)); }
    for (let index = 0; index < words.length - 2; index++) {
      const phrase = words.slice(index, index + 3);
      if (!/^Verify at [qg]red\.org$/.test(phrase.map(word => word.text).join(" "))) continue;
      const near = phrase.every(word => {
        const b = word.bbox;
        return b && b.y1 - b.y0 < size * .3 && b.x0 >= box.x0 - size && b.x1 <= box.x1 + size &&
          ((b.y0 >= box.y1 && b.y1 < box.y1 + size * .7) || (b.y1 <= box.y0 && b.y0 > box.y0 - size * .7) ||
            (b.x0 >= box.x1 && b.x1 < box.x1 + size && b.y0 >= box.y0 && b.y1 <= box.y1));
      });
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
