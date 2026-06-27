const TOKEN_RE = /\s+|[A-Za-z]+|[0-9]+|\*|[^A-Za-z0-9\s]/g;

const WORD_TO_CODE = {
  the: "a",
  and: "b",
  to: "c",
  of: "d",
  in: "e",
  for: "f",
  is: "g",
  on: "h",
  with: "i",
  that: "j",
  this: "k",
  it: "l",
  as: "m",
  are: "n",
  be: "o",
  at: "p",
  by: "q",
  from: "r",
  or: "s",
  not: "t",
  you: "u",
  we: "v",
  can: "w",
  if: "x",
  one: "y",
  all: "z",
  document: "0",
  page: "1",
  qr: "2",
  code: "3",
  text: "4",
  plain: "5",
  recipe: "6",
  automatic: "7",
  legacy: "8",
  compression: "9",
  simple: "A",
  english: "B",
  valid: "C",
  reversible: "D",
  encoding: "E",
  strategy: "F",
  readable: "G",
  choose: "H",
  smallest: "I",
  content: "J",
  seal: "K",
  verify: "L",
  select: "M",
  word: "N",
  line: "O",
  sentence: "P",
  support: "Q",
  rejected: "R",
};

const CODE_TO_WORD = Object.fromEntries(Object.entries(WORD_TO_CODE).map(([word, code]) => [code, word]));
const APPROVED_ACRONYMS = new Set(["API", "HTTP", "HTTPS", "ID", "JSON", "NASA", "PDF", "PNG", "QR", "QRED", "SHA", "URL", "XML"]);

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

function describeWordFailure(token) {
  if (token === token.toUpperCase()) return "Unknown acronym.";
  if (token === token.toLowerCase() || token[0] === token[0]?.toUpperCase()) return "Unsupported word for Recipe 1.";
  return "Unsupported mixed-case word.";
}

function encodeWord(token) {
  const lower = token.toLowerCase();
  if (Object.hasOwn(WORD_TO_CODE, lower)) {
    const code = WORD_TO_CODE[lower];
    if (token === token.toLowerCase()) return `*${code}`;
    if (token[0] === token[0].toUpperCase() && token.slice(1) === token.slice(1).toLowerCase()) return `^${code}`;
    if (token === token.toUpperCase()) return `!${code}`;
    return { diagnostic: { line: 1, reason: "Unsupported mixed-case word.", original: token, recommendation: "Rewrite the word in plain lowercase, title case, or approved acronym form." } };
  }
  if (token === token.toUpperCase() && APPROVED_ACRONYMS.has(token)) return token;
  return { diagnostic: { line: 1, reason: describeWordFailure(token), original: token, recommendation: "Add this word to the recipe dictionary, rewrite it as a supported common word, or choose plaintext/legacy compression." } };
}

export function encodeSimpleEnglish(text) {
  const diagnostics = [];
  const pieces = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[0];
    const line = lineNumber(text, match.index ?? 0);
    if (token === "*") {
      diagnostics.push({ line, reason: "Literal '*' is not allowed in Recipe 1.", original: token, recommendation: "Replace '*' with a spelled-out word or use plaintext." });
      continue;
    }
    if (/^\s+$/.test(token)) {
      pieces.push(token);
      continue;
    }
    if (/^[0-9]+$/.test(token) || /^[.,!?;:\-()\[\]{}'"/\\]$/.test(token)) {
      pieces.push(token);
      continue;
    }
    if (/^[A-Za-z]+$/.test(token)) {
      const encoded = encodeWord(token);
      if (typeof encoded === "string") {
        pieces.push(encoded);
      } else {
        diagnostics.push({ line, ...encoded.diagnostic });
      }
      continue;
    }
    diagnostics.push({ line, reason: "Unsupported character sequence for Recipe 1.", original: token, recommendation: "Use only supported English words, digits, spaces, and simple punctuation." });
  }
  const compact = pieces.join("");
  const restored = diagnostics.length ? "" : decodeSimpleEnglish(compact);
  return { compact, restored, diagnostics };
}

export function decodeSimpleEnglish(compact) {
  let restored = "";
  for (let index = 0; index < compact.length; index += 1) {
    const char = compact[index];
    if (char === "*" || char === "^" || char === "!") {
      const code = compact[index + 1];
      if (!code || !Object.hasOwn(CODE_TO_WORD, code)) {
        throw new Error(`Unknown Recipe 1 code: ${code || "<truncated>"}`);
      }
      const word = CODE_TO_WORD[code];
      restored += char === "*" ? word : char === "^" ? word[0].toUpperCase() + word.slice(1) : word.toUpperCase();
      index += 1;
      continue;
    }
    restored += char;
  }
  return restored;
}

export function validateSimpleEnglish(original) {
  const { compact, restored, diagnostics } = encodeSimpleEnglish(original);
  if (diagnostics.length) {
    return { recipe_id: "recipe1", reversible: false, compact, restored: "", diagnostics };
  }
  return { recipe_id: "recipe1", reversible: restored === original, compact, restored, diagnostics: restored === original ? [] : [{ line: 1, reason: "Recipe 1 round-trip did not restore the original text.", original, restored, recommendation: "Rewrite the document using supported simple-English patterns or use plaintext." }] };
}
