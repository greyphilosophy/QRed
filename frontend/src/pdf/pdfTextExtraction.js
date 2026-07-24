// Extraction helpers for PDF text extraction — lifted pure functions from pdfClientSeal.js
// Minimal ToUnicode CMap parsing + literal/hex content stream decoding.

export function bytesToLatin1(bytes) {
  return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
}

function decodePdfLiteralString(raw) {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== "\\") { out += ch; continue; }
    i += 1;
    const next = raw[i];
    if (next === undefined) break;
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "b") out += "\b";
    else if (next === "f") out += "\f";
    else if (next === "(" || next === ")" || next === "\\") out += next;
    else if (/[0-7]/.test(next)) {
      let oct = next;
      for (let j = 0; j < 2 && /[0-7]/.test(raw[i + 1]); j += 1) { i += 1; oct += raw[i]; }
      out += String.fromCharCode(Number.parseInt(oct, 8));
    } else out += next;
  }
  return out;
}

export async function maybeInflate(bytes) {
  try {
    const tryInflate = async (payload) => {
      const stream = new Blob([payload]).stream().pipeThrough(new DecompressionStream("deflate"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    };
    try { return await tryInflate(bytes); } catch {
      if (bytes && bytes.length > 6 && bytes[0] === 0x78) {
        const unwrapped = bytes.subarray(2, bytes.length - 4);
        return await tryInflate(unwrapped);
      }
      throw new Error("inflate failed");
    }
  } catch { return bytes; }
}

export function parseCMap(text) {
  const map = new Map();
  const bfcharPattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
  for (const match of text.matchAll(bfcharPattern)) {
    const code = match[1].toUpperCase();
    const unicode = match[2];
    const chars = [];
    for (let i = 0; i < unicode.length; i += 4) {
      const cp = Number.parseInt(unicode.slice(i, i + 4), 16);
      if (!Number.isNaN(cp)) chars.push(String.fromCodePoint(cp));
    }
    map.set(code, chars.join(""));
  }
  return map;
}

function decodeBytesWithMap(bytes, fontMap) {
  if (!fontMap || fontMap.size === 0) return bytesToLatin1(bytes);
  const firstKey = fontMap.keys().next().value;
  const keyLen = typeof firstKey === "string" ? firstKey.length : 0;
  const bytesPerChar = keyLen % 2 === 0 && keyLen > 0 ? keyLen / 2 : 1;
  let out = "";
  for (let i = 0; i < bytes.length; i += bytesPerChar) {
    const slice = bytes.slice(i, i + bytesPerChar);
    if (slice.length === bytesPerChar) {
      const key = Array.from(slice, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join("");
      out += fontMap.get(key) ?? String.fromCharCode(slice[slice.length - 1]);
    } else {
      for (const byte of slice) {
        const key = byte.toString(16).toUpperCase().padStart(2, "0");
        out += fontMap.get(key) ?? String.fromCharCode(byte);
      }
    }
  }
  return out;
}

export function extractTextFromContentString(content, fontMap) {
  const texts = [];
  const scanner = /\/([!#-~]+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]+)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj|\[(.*?)\]\s*TJ/gs;
  let currentFont = fontMap;
  for (const match of content.matchAll(scanner)) {
    if (match[1]) {
      currentFont = fontMap?.[match[1]] || fontMap?.get?.(match[1]) || null;
      continue;
    }
    if (match[2]) {
      const hex = match[2];
      if (hex.length % 2 !== 0) continue;
      const bytes = new Uint8Array(hex.length / 2);
      for (let index = 0; index < hex.length; index += 2) {
        bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
      }
      texts.push(decodeBytesWithMap(bytes, currentFont));
      continue;
    }
    if (match[3]) {
      texts.push(decodeBytesWithMap(Uint8Array.from(match[3], (ch) => ch.charCodeAt(0)), currentFont));
      continue;
    }
    if (match[4]) {
      const chunk = match[4];
      const pieces = [...chunk.matchAll(/<([0-9A-Fa-f]+)>|\(((?:\\.|[^\\)])*)\)/g)];
      for (const piece of pieces) {
        if (piece[1]) {
          const hex = piece[1];
          if (hex.length % 2 !== 0) continue;
          const bytes = new Uint8Array(hex.length / 2);
          for (let index = 0; index < hex.length; index += 2) {
            bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
          }
          texts.push(decodeBytesWithMap(bytes, currentFont));
        } else if (piece[2]) {
          texts.push(decodeBytesWithMap(Uint8Array.from(decodePdfLiteralString(piece[2]), (ch) => ch.charCodeAt(0)), currentFont));
        }
      }
    }
  }

  return texts.join("").replace(/\s+/g, " ").trim();
}
