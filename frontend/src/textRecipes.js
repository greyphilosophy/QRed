const B45_RECIPE_ID = "b45";

// Browser implementation sourced from the b45 reference project demo:
// https://github.com/greyphilosophy/b45/blob/main/docs/demo.html
const QR_ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const PASS_THROUGH = new Set("0123456789 $.-: ".split(""));
const SHIFT_DECODE_BY_KEY = {
  "1": "!", "2": "@", "3": "#", "6": "^",
  "7": "&", "9": "(", "0": ")", "/": "?", ":": ";",
};
const SHIFT_ENCODE_BY_CHAR = Object.fromEntries(
  Object.entries(SHIFT_DECODE_BY_KEY).map(([key, value]) => [value, key]),
);
const SPECIAL_SINGLE_DECODE_BY_CHAR = { "*": "\"" };
const HEX = new Set("0123456789ABCDEF".split(""));
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function codePointAt(text, index) {
  return String.fromCodePoint(text.codePointAt(index));
}

function encodeUtf8Escape(char, parts) {
  for (const byte of textEncoder.encode(char)) {
    parts.push(`%${byte.toString(16).toUpperCase().padStart(2, "0")}`);
  }
}

function appendPeriodRun(text, index, parts) {
  const start = index;
  while (index < text.length && text[index] === ".") index += 1;
  if (index - start === 1) {
    parts.push(".");
  } else {
    for (let cursor = start; cursor < index; cursor += 1) encodeUtf8Escape(".", parts);
  }
  return index;
}

function encodeApostropheSlashRun(text, index, parts) {
  const start = index;
  while (index < text.length && (text[index] === "'" || text[index] === "/")) index += 1;
  if (index - start === 1) {
    parts.push(text[start] === "'" ? "/" : "//");
  } else {
    for (let cursor = start; cursor < index; cursor += 1) encodeUtf8Escape(text[cursor], parts);
  }
  return index;
}

function encodeChar(char, parts) {
  if (char >= "a" && char <= "z") parts.push(char.toUpperCase());
  else if (char >= "A" && char <= "Z") parts.push(`+${char}`);
  else if (char === "+") parts.push("++");
  else if (char === "%") parts.push("%%");
  else if (char === "\"") parts.push("*");
  else if (char === "*") encodeUtf8Escape(char, parts);
  else if (char === ":") parts.push("::");
  else if (PASS_THROUGH.has(char)) parts.push(char);
  else if (SHIFT_ENCODE_BY_CHAR[char]) parts.push(`+${SHIFT_ENCODE_BY_CHAR[char]}`);
  else encodeUtf8Escape(char, parts);
}

export function encodeB45ish(text) {
  const parts = [];
  let index = 0;
  while (index < text.length) {
    const char = codePointAt(text, index);
    if (char === ",") {
      if (index + 1 < text.length && text[index + 1] === ":") encodeUtf8Escape(char, parts);
      else parts.push(":");
      index += 1;
      continue;
    }
    if (char === ".") {
      index = appendPeriodRun(text, index, parts);
      continue;
    }
    if (char === "'" || char === "/") {
      index = encodeApostropheSlashRun(text, index, parts);
      continue;
    }
    encodeChar(char, parts);
    index += char.length;
  }
  return parts.join("");
}

function decodePlusEscape(encoded, index) {
  if (index + 1 >= encoded.length) throw new Error("Dangling '+' escape at end of input");
  const nextChar = encoded[index + 1];
  if (nextChar === "+") return ["+", index + 2];
  if (nextChar >= "A" && nextChar <= "Z") return [nextChar, index + 2];
  if (SHIFT_DECODE_BY_KEY[nextChar]) return [SHIFT_DECODE_BY_KEY[nextChar], index + 2];
  throw new Error(`Invalid '+' escape at position ${index}: '+${nextChar}'`);
}

function decodeColonEscape(encoded, index) {
  if (index + 1 < encoded.length && encoded[index + 1] === ":") return [":", index + 2];
  return [",", index + 1];
}

function decodeSlashEscape(encoded, index) {
  if (index + 1 < encoded.length && encoded[index + 1] === "/") return ["/", index + 2];
  return ["'", index + 1];
}

function isHexByte(value) {
  return value.length === 2 && [...value].every((char) => HEX.has(char));
}

function decodePercentRun(encoded, index) {
  if (index + 1 < encoded.length && encoded[index + 1] === "%") return ["%", index + 2];
  const bytes = [];
  const start = index;
  while (index < encoded.length && encoded[index] === "%") {
    if (index + 2 >= encoded.length) throw new Error(`Incomplete percent escape at position ${index}`);
    const hexDigits = encoded.slice(index + 1, index + 3);
    if (!isHexByte(hexDigits)) {
      if (index === start) throw new Error(`Invalid percent escape at position ${index}: '%${hexDigits}'`);
      break;
    }
    bytes.push(Number.parseInt(hexDigits, 16));
    index += 3;
  }
  try {
    return [textDecoder.decode(new Uint8Array(bytes)), index];
  } catch {
    throw new Error(`Invalid UTF-8 byte escape run starting at position ${start}`);
  }
}

export function decodeB45ish(encoded) {
  const output = [];
  let index = 0;
  while (index < encoded.length) {
    const char = encoded[index];
    if (!QR_ALPHANUMERIC.includes(char)) throw new Error(`Invalid b45 character at position ${index}: ${JSON.stringify(char)}`);
    if (char === "+") {
      const [decoded, nextIndex] = decodePlusEscape(encoded, index);
      output.push(decoded);
      index = nextIndex;
    } else if (char === ":") {
      const [decoded, nextIndex] = decodeColonEscape(encoded, index);
      output.push(decoded);
      index = nextIndex;
    } else if (SPECIAL_SINGLE_DECODE_BY_CHAR[char]) {
      output.push(SPECIAL_SINGLE_DECODE_BY_CHAR[char]);
      index += 1;
    } else if (char === "/") {
      const [decoded, nextIndex] = decodeSlashEscape(encoded, index);
      output.push(decoded);
      index = nextIndex;
    } else if (char === "%") {
      const [decoded, nextIndex] = decodePercentRun(encoded, index);
      output.push(decoded);
      index = nextIndex;
    } else if (char >= "A" && char <= "Z") {
      output.push(char.toLowerCase());
      index += 1;
    } else if (PASS_THROUGH.has(char)) {
      output.push(char);
      index += 1;
    } else {
      throw new Error(`Invalid b45 character at position ${index}: ${JSON.stringify(char)}`);
    }
  }
  return output.join("");
}

export function validateB45(original) {
  const compact = encodeB45ish(original);
  try {
    const restored = decodeB45ish(compact);
    const reversible = restored === original;
    return {
      recipe_id: B45_RECIPE_ID,
      reversible,
      compact,
      restored,
      diagnostics: reversible ? [] : [{
        line: 1,
        reason: "b45 round-trip did not restore the original text.",
        original,
        restored,
        recommendation: "Use plaintext or legacy compression instead.",
      }],
    };
  } catch (error) {
    return {
      recipe_id: B45_RECIPE_ID,
      reversible: false,
      compact,
      restored: "",
      diagnostics: [{
        line: 1,
        reason: `b45 decoding failed: ${error.message}`,
        original,
        recommendation: "Use plaintext or legacy compression instead.",
      }],
    };
  }
}

// Compatibility aliases for older call sites.
export const encodeSimpleEnglish = encodeB45ish;
export const decodeSimpleEnglish = decodeB45ish;
export const validateSimpleEnglish = validateB45;
