// Compare independently recognized text with authenticated text. Whitespace and
// canonical Unicode composition are the only ignored differences. In particular,
// never case-fold, strip punctuation, or substitute lookalike letters/digits.
const MAX_TEXT_LENGTH = 60000;
const MAX_TOKENS = 4000;
const MAX_ALIGNMENT_CELLS = 4_000_000;
export const OCR_REVIEW_THRESHOLD = 85; // A review heuristic, NOT a probability of authenticity.

function tokenize(text) {
  return [...text.normalize("NFC").matchAll(/[\p{L}\p{M}\p{N}]+|[^\s]/gu)]
    .map(match => ({ value: match[0], start: match.index, end: match.index + match[0].length }));
}

function validBox(box, width, height) {
  return box && [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)
    && box.x0 >= 0 && box.y0 >= 0 && box.x1 > box.x0 && box.y1 > box.y0
    && box.x1 <= width && box.y1 <= height;
}

export function comparePhotoText(expectedText, words, { width, height } = {}) {
  if (typeof expectedText !== "string" || !Array.isArray(words)) throw new Error("No text available for comparison.");
  if (expectedText.length > MAX_TEXT_LENGTH || words.length > MAX_TOKENS
      || words.reduce((sum, word) => sum + String(word.text || "").length, 0) > MAX_TEXT_LENGTH) {
    throw new Error("This page has too much text for photo comparison. Compare its recovered text manually.");
  }
  const expected = expectedText.normalize("NFC");
  const reference = tokenize(expected);
  const observed = words.flatMap((word, wordIndex) => tokenize(String(word.text || "")).map(token => ({ ...token, wordIndex })));
  if (!reference.length) throw new Error("The seal contains no text to compare.");
  const columns = observed.length + 1;
  if (reference.length > MAX_TOKENS || observed.length > MAX_TOKENS
      || (reference.length + 1) * columns > MAX_ALIGNMENT_CELLS) {
    throw new Error("This page has too much text for photo comparison. Compare its recovered text manually.");
  }

  // Bounded sequence alignment: repeated words must occur the right number of
  // times and in the right reading order. A word-set comparison would miss edits.
  const table = new Uint16Array((reference.length + 1) * columns);
  for (let i = reference.length - 1; i >= 0; i -= 1) {
    for (let j = observed.length - 1; j >= 0; j -= 1) {
      table[i * columns + j] = reference[i].value === observed[j].value
        ? table[(i + 1) * columns + j + 1] + 1
        : Math.max(table[(i + 1) * columns + j], table[i * columns + j + 1]);
    }
  }
  const matched = new Set();
  const differences = [];
  let pending = null;
  const flush = () => {
    if (!pending) return;
    const indices = [...pending.wordIndices];
    differences.push({
      expected: pending.start === null ? "" : expected.slice(pending.start, pending.end),
      observed: indices.map(index => words[index].text).join(" "),
      wordIndices: indices,
    });
    pending = null;
  };
  let i = 0, j = 0;
  while (i < reference.length || j < observed.length) {
    if (i < reference.length && j < observed.length && reference[i].value === observed[j].value) {
      flush();
      matched.add(j);
      i += 1; j += 1;
    } else {
      pending ??= { start: null, end: null, wordIndices: new Set() };
      if (i < reference.length && (j === observed.length
          || table[(i + 1) * columns + j] >= table[i * columns + j + 1])) {
        pending.start ??= reference[i].start;
        pending.end = reference[i].end;
        i += 1;
      } else {
        pending.wordIndices.add(observed[j].wordIndex);
        j += 1;
      }
    }
  }
  flush();
  const tokenIndices = words.map(() => []);
  observed.forEach((token, index) => tokenIndices[token.wordIndex].push(index));
  const classified = words.map((word, index) => {
    const indices = tokenIndices[index];
    const box = validBox(word.bbox, width, height) ? word.bbox : null;
    const uncertain = !Number.isFinite(word.confidence) || word.confidence < OCR_REVIEW_THRESHOLD || !box;
    const agrees = indices.length > 0 && indices.every(tokenIndex => matched.has(tokenIndex));
    return { text: String(word.text || ""), bbox: box, confidence: word.confidence,
      status: uncertain ? "uncertain" : agrees ? "matched" : "different", agrees };
  }).filter(word => word.text.trim());
  const uncertainCount = classified.filter(word => word.status === "uncertain").length;
  return {
    words: classified, differences,
    matchedCount: classified.filter(word => word.status === "matched").length,
    differentCount: classified.filter(word => word.status === "different").length,
    uncertainCount,
    status: !observed.length ? "unreadable" : differences.length ? "differences" : uncertainCount ? "uncertain" : "matches",
  };
}
