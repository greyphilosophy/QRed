// Compare independently recognized text with authenticated text. Whitespace and
// canonical Unicode composition are the only ignored differences. In particular,
// never case-fold, strip punctuation, or substitute lookalike letters/digits.
// Typography and split/joined words remain visible review items, never matches.
const MAX_TEXT_LENGTH = 60000;
const MAX_TOKENS = 4000;
const MAX_ALIGNMENT_CELLS = 4_000_000;
export const OCR_REVIEW_THRESHOLD = 85; // A review heuristic, NOT a probability of authenticity.

function tokenize(text) {
  return [...text.normalize("NFC").matchAll(/[\p{L}\p{M}\p{N}]+|[^\s]/gu)]
    .map(match => ({ value: match[0], start: match.index, end: match.index + match[0].length }));
}

function typographyKey(text) {
  const ligatures = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };
  // Deliberately narrower than NFKC: currency, fractions, superscripts,
  // circled digits, accents and alphabet lookalikes keep their distinctions.
  const normalized = text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')
    .replace(/[‐‑–—−]/g, "-").replace(/[ﬀ-ﬆ]/g, value => ligatures[value]);
  return tokenize(normalized).map(token => token.value).join("\u0000");
}

function validBox(box, width, height) {
  return box && [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)
    && box.x0 >= 0 && box.y0 >= 0 && box.x1 > box.x0 && box.y1 > box.y0
    && box.x1 <= width && box.y1 <= height;
}

export function boundedPhotoTokens(expectedText, words) {
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
  return { expected, reference, observed };
}

export function comparePhotoText(expectedText, words, { width, height } = {}) {
  const { expected, reference, observed } = boundedPhotoTokens(expectedText, words);
  const referenceKeys = reference.map(token => typographyKey(token.value));
  const observedKeys = observed.map(token => typographyKey(token.value));
  const columns = observed.length + 1;

  // Bounded sequence alignment: repeated words must occur the right number of
  // times and in the right reading order. A word-set comparison would miss edits.
  const table = new Uint16Array((reference.length + 1) * columns);
  for (let i = reference.length - 1; i >= 0; i -= 1) {
    for (let j = observed.length - 1; j >= 0; j -= 1) {
      table[i * columns + j] = referenceKeys[i] === observedKeys[j]
        ? table[(i + 1) * columns + j + 1] + 1
        : Math.max(table[(i + 1) * columns + j], table[i * columns + j + 1]);
    }
  }
  const matched = new Set();
  const typographyTokens = new Set();
  const differences = [];
  let pending = null;
  const flush = () => {
    if (!pending) return;
    const indices = [...pending.wordIndices];
    const signed = pending.start === null ? "" : expected.slice(pending.start, pending.end);
    const readTokens = pending.tokenIndices.map(index => observed[index].value).join(" ");
    const typography = signed.length > 0 && readTokens.length > 0 && typographyKey(signed) === typographyKey(readTokens);
    // Do not edit characters or discard punctuation. Even an exact character
    // sequence with different word boundaries still needs a person's review
    // ("now here" and "nowhere" need not mean the same thing).
    const spacing = !typography && signed.length > 0 && readTokens.length > 0
      && signed.replace(/\s/gu, "") === readTokens.replace(/\s/gu, "");
    if (typography || spacing) pending.tokenIndices.forEach(index => typographyTokens.add(index));
    differences.push({
      expected: signed,
      context: pending.start === null ? "" : expected.slice(Math.max(0, pending.start - 70), Math.min(expected.length, pending.end + 70)),
      observed: typography ? readTokens : indices.map(index => words[index].text).join(" "),
      wordIndices: indices,
      ...(typography ? { typography: true } : {}),
      ...(spacing ? { spacing: true } : {}),
    });
    pending = null;
  };
  let i = 0, j = 0;
  while (i < reference.length || j < observed.length) {
    if (i < reference.length && j < observed.length && referenceKeys[i] === observedKeys[j]) {
      flush();
      if (reference[i].value === observed[j].value) matched.add(j);
      else {
        typographyTokens.add(j);
        differences.push({ expected: reference[i].value, observed: observed[j].value,
          wordIndices: [observed[j].wordIndex], typography: true,
          context: expected.slice(Math.max(0, reference[i].start - 70), Math.min(expected.length, reference[i].end + 70)) });
      }
      i += 1; j += 1;
    } else {
      pending ??= { start: null, end: null, wordIndices: new Set(), tokenIndices: [] };
      if (i < reference.length && (j === observed.length
          || table[(i + 1) * columns + j] >= table[i * columns + j + 1])) {
        pending.start ??= reference[i].start;
        pending.end = reference[i].end;
        i += 1;
      } else {
        pending.wordIndices.add(observed[j].wordIndex);
        pending.tokenIndices.push(j);
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
    const typographyOnly = !agrees && indices.length > 0
      && indices.every(tokenIndex => matched.has(tokenIndex) || typographyTokens.has(tokenIndex));
    return { text: String(word.text || ""), sourceIndex: index, bbox: box, confidence: word.confidence,
      status: uncertain || typographyOnly ? "uncertain" : agrees ? "matched" : "different", agrees };
  }).filter(word => word.text.trim());
  const uncertainCount = classified.filter(word => word.status === "uncertain").length;
  return {
    words: classified, differences,
    matchedCount: classified.filter(word => word.status === "matched").length,
    differentCount: classified.filter(word => word.status === "different").length,
    uncertainCount,
    status: !observed.length ? "unreadable" : differences.some(difference => !difference.typography && !difference.spacing)
      ? "differences" : uncertainCount ? "uncertain" : "matches",
  };
}
