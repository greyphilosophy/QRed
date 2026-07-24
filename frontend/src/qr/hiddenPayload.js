// Single source of truth for QRed's hidden-payload carrier framing.
// QRed QR codes visibly scan as QRED.ORG but hide signed data in padding.

export const VISIBLE_QR_TEXT = "QRED.ORG";
const HIDDEN_PAYLOAD_LENGTH_BYTES = 2;

function bytesFrom(value) {
  if (!value) return new Uint8Array();
  return value instanceof Uint8Array ? value : Uint8Array.from(value);
}

function alphanumericDataBitLength(text) {
  const pairs = Math.floor(text.length / 2);
  const remainder = text.length % 2;
  return (pairs * 11) + (remainder * 6);
}

function qrCharacterCountBitLength(version) {
  if (!version || version <= 9) return 9;
  if (version <= 26) return 11;
  return 13;
}

export function hiddenPayloadByteOffset(version) {
  const visibleBits = 4 + qrCharacterCountBitLength(version) + alphanumericDataBitLength(VISIBLE_QR_TEXT);
  const afterTerminatorBits = visibleBits + 4;
  return Math.ceil(afterTerminatorBits / 8);
}

export function framedPayloadFrom(bytes, lengthOffset) {
  const payloadOffset = lengthOffset + HIDDEN_PAYLOAD_LENGTH_BYTES;
  if (payloadOffset > bytes.length) return null;
  const payloadLength = (bytes[lengthOffset] << 8) | bytes[lengthOffset + 1];
  const payloadEnd = payloadOffset + payloadLength;
  if (payloadEnd > bytes.length) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(payloadOffset, payloadEnd));
  } catch {
    return null;
  }
}

export function extractHiddenQRedPayload(binaryData, version) {
  const bytes = bytesFrom(binaryData);
  const payloadOffset = hiddenPayloadByteOffset(version);
  if (payloadOffset >= bytes.length) return null;
  return framedPayloadFrom(bytes, payloadOffset);
}

export function isQRedVisibleText(text) {
  if (!text) return false;
  return text === VISIBLE_QR_TEXT || text.includes("QRED1") || text.includes("qred.org");
}

export { HIDDEN_PAYLOAD_LENGTH_BYTES };
