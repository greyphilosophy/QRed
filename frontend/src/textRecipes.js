const B45_RECIPE_ID = "b45";
const DIRECT_PUNCTUATION = new Set([".", "-", "/", ":", "$", " " ]);
const HEX_DIGITS = new Set("0123456789ABCDEF");

function utf8BytesToString(bytes) {
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
}

function flushUtf8Bytes(buffer, output) {
  if (buffer.length) {
    output.push(utf8BytesToString(buffer));
    buffer.length = 0;
  }
}

export function encodeB45ish(text) {
  const pieces = [];
  for (const char of text) {
    if (char >= "a" && char <= "z") {
      pieces.push(char.toUpperCase());
    } else if (char >= "A" && char <= "Z") {
      pieces.push(`+${char}`);
    } else if (char === "%" || char === "+") {
      pieces.push(char + char);
    } else if (char.length === 1 && (char >= "0" && char <= "9" || DIRECT_PUNCTUATION.has(char))) {
      pieces.push(char);
    } else {
      const bytes = new TextEncoder().encode(char);
      for (const byte of bytes) pieces.push(`%${byte.toString(16).toUpperCase().padStart(2, "0")}`);
    }
  }
  return pieces.join("");
}

export function decodeB45ish(compact) {
  const restored = [];
  const utf8Bytes = [];
  for (let index = 0; index < compact.length; ) {
    const char = compact[index];
    if (char === "+") {
      flushUtf8Bytes(utf8Bytes, restored);
      const code = compact[index + 1];
      if (!code || code < "A" || code > "Z") {
        throw new Error(`Invalid b45 uppercase escape: +${code || "<truncated>"}`);
      }
      restored.push(code);
      index += 2;
      continue;
    }
    if (char === "%") {
      if (compact[index + 1] === "%") {
        flushUtf8Bytes(utf8Bytes, restored);
        restored.push("%");
        index += 2;
        continue;
      }
      if (index + 2 >= compact.length) throw new Error("Truncated b45 byte escape");
      const hex = compact.slice(index + 1, index + 3);
      if (!HEX_DIGITS.has(hex[0]) || !HEX_DIGITS.has(hex[1])) {
        throw new Error(`Invalid b45 byte escape: %${hex}`);
      }
      utf8Bytes.push(Number.parseInt(hex, 16));
      index += 3;
      continue;
    }

    flushUtf8Bytes(utf8Bytes, restored);
    if (char >= "A" && char <= "Z") {
      restored.push(char.toLowerCase());
    } else if (char >= "0" && char <= "9" || DIRECT_PUNCTUATION.has(char)) {
      restored.push(char);
    } else {
      throw new Error(`Invalid b45 character: ${char}`);
    }
    index += 1;
  }
  flushUtf8Bytes(utf8Bytes, restored);
  return restored.join("");
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
