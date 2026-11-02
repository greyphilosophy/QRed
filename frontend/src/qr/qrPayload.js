import { decodeTransport, qrPayloadBytes, qrPayloadText } from "../sealFormat.js";

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

// binaryData is the decoder's ordinary message, already error-corrected and
// excluding the terminator and padding. Binary signatures need not be UTF-8.
export function qredPayloadFromScanResult(result) {
  if (!result || typeof result === "string") return null;
  if (result.binaryData?.length) {
    try {
      const bytes = Uint8Array.from(result.binaryData);
      decodeTransport(bytes);
      return qrPayloadText(bytes);
    } catch { /* A navigation code or ordinary QR message is not a seal. */ }
  }
  // A seal URL encoded as an ordinary QR message is also safe to accept.
  if (typeof result.data !== "string" || !/^(?:[^#]*#)?QRED[34]:/.test(result.data)) return null;
  try {
    decodeTransport(qrPayloadBytes(result.data));
    return result.data;
  } catch { return null; }
}
