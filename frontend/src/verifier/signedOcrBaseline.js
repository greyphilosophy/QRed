import { assignPhotoLines, signedPhotoLines } from "./photoTextLayout.js";

function validObservedBox(box, dimensions) {
  return box && [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)
    && box.x0 >= 0 && box.y0 >= 0 && box.x1 <= dimensions.width && box.y1 <= dimensions.height
    && box.x1 > box.x0 && box.y1 > box.y0;
}

const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

// Supplemental evidence only. This never edits the native comparison, its
// differences, word classifications or verdict. Equal OCR does not establish
// equal pixels or meaning: the same misreading can also conceal a real change.
export function compareSignedOcrBaseline(evidence, reference, words, corners, dimensions) {
  const baseline = evidence?.ocr?.lines;
  if (!baseline?.length) return null;
  if (baseline.length > 512 || words.length > 4000) return { located: false, readings: [] };
  // Use native text to register native PDFs; conflicting OCR cannot place itself.
  // Image-only pages have only their signed OCR reference to register against.
  const anchor = evidence.text?.trim() ? evidence : reference.evidence;
  const projected = signedPhotoLines(anchor.text, anchor, corners, dimensions, words, baseline);
  if (!projected) return { located: false, readings: [] };
  // Assign independently to each region, then reject multiple ownership rather
  // than choosing whichever overlapping region makes a reading agree.
  const assigned = projected.map(line => assignPhotoLines([line], words)[0]);
  const uses = new Map();
  assigned.forEach(line => line.wordIndices.forEach(index => uses.set(index, (uses.get(index) || 0) + 1)));
  const native = evidence.layout?.mode === 3 ? evidence.text.split("\n").filter(line => line.trim())
    .map((text, index) => ({ text, ...evidence.layout.lines[index] })) : [];
  return { located: true, readings: assigned.map((line, index) => {
    const original = baseline[index], indices = line.wordIndices;
    const nearby = native.filter(item => overlap(item, original) > 0);
    const overlappingBaseline = baseline.some((other, i) => i !== index && overlap(other, original) > 0);
    const ambiguous = overlappingBaseline || nearby.length > 1 || indices.some(i => {
      const box = words[i].bbox;
      if (uses.get(i) !== 1 || !validObservedBox(box, dimensions)) return true;
      const covered = Math.max(0, Math.min(box.x1, line.bbox.x1) - Math.max(box.x0, line.bbox.x0))
        * Math.max(0, Math.min(box.y1, line.bbox.y1) - Math.max(box.y0, line.bbox.y0));
      return covered < (box.x1 - box.x0) * (box.y1 - box.y0) * .5;
    })
      || (nearby.length === 1 && (overlap(nearby[0], original) < nearby[0].width * nearby[0].height * .5
        || overlap(nearby[0], original) < original.width * original.height * .5));
    const observed = indices.map(i => words[i].text).join(" ");
    // Exact wording including punctuation, case and word boundaries. Do not
    // choose a retry because it resembles the baseline or ignore added words.
    const repeated = !ambiguous && indices.length > 0 && observed.normalize("NFC") === original.text.normalize("NFC");
    return { baseline: original.text, native: nearby.map(item => item.text), observed,
      confidence: original.confidence, wordIndices: indices, boxes: [line.bbox],
      status: ambiguous ? "ambiguous" : !indices.length ? "unreadable" : repeated ? "repeated" : "different",
      sourceDiscrepancy: nearby.length > 0 && nearby.some(item => item.text !== original.text) };
  }) };
}
