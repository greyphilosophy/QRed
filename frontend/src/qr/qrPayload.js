import { Inflate } from "pako/lib/inflate.js";
import { decodeTransport, MAX_SEAL_TEXT_BYTES, qrPayloadBytes, qrPayloadText } from "../sealFormat.js";

export const QRED_ENTRY_TEXT = "QRED.ORG";

export function isQRedEntryLink(text) {
  return typeof text === "string" && /^(?:https?:\/\/)?qred\.org\/?$/i.test(text);
}

// Read the single ordinary byte segment emitted by QRed after Reed-Solomon
// recovery. Never search padding, skip a terminator, or infer a hidden length.
export function bytePayloadFromCodewords(data, version) {
  if (!data?.length || !Number.isInteger(version) || version < 1 || version > 40) return null;
  let offset = 0;
  function read(count) {
    let value = 0;
    for (let i = 0; i < count; i++, offset++) value = value * 2 + ((data[offset >>> 3] >>> (7 - offset % 8)) & 1);
    return value;
  }
  const countBits = version < 10 ? 8 : 16;
  if (data.length * 8 < 4 + countBits || read(4) !== 4) return null;
  const length = read(countBits);
  if (offset + length * 8 > data.length * 8) return null;
  return Uint8Array.from({ length }, () => read(8));
}

export function extractQrBytePayload(data, version) {
  const bytes = bytePayloadFromCodewords(data, version);
  if (!bytes) return null;
  try { return qrPayloadText(bytes); } catch { return null; }
}

function validateScannedPayload(bytes) {
  const record = decodeTransport(bytes);
  if (record.multipart) return;
  const data = record.data;
  // Reject damaged compressed candidates before they can stop optical recovery.
  // Framing alone is insufficient: an over-corrected QR can retain its header
  // but contain invalid DEFLATE data or a wrong checksum. This bounded check
  // never authenticates content; normal native decoding/signatures still run.
  if (record.encoding === "zlib" && (data.length < 6 || (data[0] & 15) !== 8
    || (data[0] >>> 4) > 7 || (data[0] * 256 + data[1]) % 31 !== 0 || (data[1] & 32))) {
    throw new Error("Invalid zlib header");
  }
  if (record.encoding === "gzip" && (data.length < 18 || data[0] !== 31 || data[1] !== 139
    || data[2] !== 8 || (data[3] & 224))) throw new Error("Invalid gzip header");
  if (record.encoding !== "plaintext") {
    const inflater = new Inflate({ windowBits: record.encoding === "zlib" ? 15 : 31, chunkSize: 16384 });
    let length = 0;
    inflater.onData = chunk => {
      length += chunk.length;
      if (length > MAX_SEAL_TEXT_BYTES) throw new Error("Compressed seal exceeds the text limit");
    };
    // Without forced finalization, ended is true only after the actual stream
    // terminator and checksum. Otherwise a truncated stream could look finished.
    if (!inflater.push(data, false) || !inflater.ended || inflater.err || inflater.strm.avail_in) {
      throw new Error("Invalid compressed seal");
    }
  }
}

// binaryData is the decoder's ordinary message, already error-corrected and
// excluding the terminator and padding. Binary signatures need not be UTF-8.
export function qredPayloadFromScanResult(result) {
  if (!result || typeof result === "string") return null;
  if (result.binaryData?.length) {
    try {
      const bytes = Uint8Array.from(result.binaryData);
      validateScannedPayload(bytes);
      return qrPayloadText(bytes);
    } catch { /* A navigation code or ordinary QR message is not a seal. */ }
  }
  // A seal URL encoded as an ordinary QR message is also safe to accept.
  if (typeof result.data !== "string" || !/^(?:[^#]*#)?QRED[34]:/.test(result.data)) return null;
  try {
    validateScannedPayload(qrPayloadBytes(result.data));
    return result.data;
  } catch { return null; }
}
