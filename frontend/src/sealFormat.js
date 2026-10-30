import { decodeIdentity, encodeIdentity } from "./attestation.js";

// QRed v3 local signatures and v4 account attestations share compact transport.
// URLs are a copy/paste representation only; the QR carries these raw bytes.
export const DEFAULT_BOOTSTRAP_URL = "https://qred.org/";
export const MAX_SEAL_TEXT_BYTES = 8 * 1024 * 1024;
export const MAX_COMPRESSED_BYTES = MAX_SEAL_TEXT_BYTES + 65536;
export const MAX_ENVELOPE_BYTES = MAX_COMPRESSED_BYTES + 1024;
export const MAX_QR_PAYLOAD_BYTES = 2945;
export const CHUNK_HEADER_BYTES = 40;
export const MAX_CHUNKS = 4096;
export const SIGNATURE_BYTES = 64;
const metadataByteLength = multiple => 17 + (multiple ? 36 : 0);

// Shared by the wire encoder and the optional-evidence budget planner.
export function sealEnvelopeOverhead({ attested = false, multiple = false, identityBytes = 0 } = {}) {
  return RECORD_MAGIC.length + metadataByteLength(multiple) + SIGNATURE_BYTES
    + (attested ? identityBytes : 0);
}
const RECORD_MAGIC = new Uint8Array([81, 82, 83, 51]); // QRS3
const CHUNK_MAGIC = new Uint8Array([81, 82, 67, 51]); // QRC3
const ATTESTED_MAGIC = new Uint8Array([81, 82, 83, 52]); // QRS4
const ATTESTED_CHUNK_MAGIC = new Uint8Array([81, 82, 67, 52]); // QRC4
export const utf8 = new TextEncoder();
export const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Native encoders/workers can return byte views from another JS realm.
// instanceof Uint8Array is not reliable across those boundaries.
export function signedContentBytes(content) {
  if (typeof content === "string") return utf8.encode(content);
  if (ArrayBuffer.isView(content) && content.BYTES_PER_ELEMENT === 1) {
    return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  }
  throw new Error("Invalid signed content");
}

export function concatenate(parts) {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

export function bytesEqual(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

export function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(value, length) {
  if (typeof value !== "string" || value.length !== length * 2 || !/^[0-9a-f]+$/.test(value)) throw new Error("Invalid binary identifier");
  return Uint8Array.from(value.match(/../g), pair => parseInt(pair, 16));
}

export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// Keys may use standard Base64 or Base64URL. Seal strings are checked more
// strictly below so different spellings cannot disguise conflicting scans.
export function decodeBase64Url(value) {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

export function encodeMetadata(metadata) {
  const { timestamp, key_id: keyId, pdf = false, page_number: pageNumber, page_count: pageCount } = metadata;
  const milliseconds = Date.parse(timestamp);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new Error("Invalid seal timestamp");
  if (pdf && (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 65535 ||
    !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount)) throw new Error("Invalid PDF page position/count");
  const multiple = pdf && pageCount > 1;
  const bytes = new Uint8Array(metadataByteLength(multiple));
  const view = new DataView(bytes.buffer);
  if (metadata.page_evidence && !pdf) throw new Error("Page evidence requires PDF page context");
  bytes[0] = (pdf ? 2 : 0) | (multiple ? 4 : 0) | (metadata.page_evidence ? 16 : 0);
  view.setBigUint64(1, BigInt(milliseconds));
  bytes.set(hexToBytes(keyId, 8), 9);
  if (multiple) {
    view.setUint16(17, pageNumber - 1);
    view.setUint16(19, pageCount);
    bytes.set(hexToBytes(metadata.document_root, 32), 21);
  }
  return bytes;
}

export function encodeEnvelope(metadata, signature, body, encoding) {
  if (!["plaintext", "zlib", "gzip"].includes(encoding)) throw new Error("Unsupported seal encoding");
  if (signature.length !== SIGNATURE_BYTES || !body.length || body.length > MAX_COMPRESSED_BYTES) throw new Error("Invalid seal record length");
  const header = encodeMetadata(metadata);
  if (encoding === "gzip") header[0] |= 1;
  if (encoding === "zlib") header[0] |= 8;
  if (metadata.version === "4") {
    return concatenate([ATTESTED_MAGIC, header, encodeIdentity(metadata.identity), signature, body]);
  }
  return concatenate([RECORD_MAGIC, header, signature, body]);
}

function hasMagic(bytes, magic) {
  return magic.every((byte, index) => bytes[index] === byte);
}

export function decodeEnvelope(bytes) {
  const attested = hasMagic(bytes, ATTESTED_MAGIC);
  if ((!attested && !hasMagic(bytes, RECORD_MAGIC)) || bytes.length <= sealEnvelopeOverhead() || bytes.length > MAX_ENVELOPE_BYTES) throw new Error("Invalid or truncated seal record");
  const flags = bytes[4];
  if ((flags & ~31) || ((flags & 9) === 9) || ((flags & 20) && !(flags & 2))) throw new Error("Unsupported seal flags");
  const multiple = Boolean(flags & 4);
  let signatureOffset = RECORD_MAGIC.length + metadataByteLength(multiple);
  let identity;
  if (attested) {
    const decoded = decodeIdentity(bytes, signatureOffset);
    identity = decoded.identity;
    signatureOffset = decoded.offset;
  }
  const bodyOffset = signatureOffset + SIGNATURE_BYTES;
  if (bytes.length <= bodyOffset) throw new Error("Truncated seal record");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const milliseconds = view.getBigUint64(5);
  if (milliseconds > 8640000000000000n) throw new Error("Invalid seal timestamp");
  const pdf = Boolean(flags & 2);
  const pageNumber = multiple ? view.getUint16(21) + 1 : 1;
  const pageCount = multiple ? view.getUint16(23) : 1;
  if ((multiple && pageCount < 2) || pageNumber > pageCount) throw new Error("Invalid PDF page position/count");
  const encoding = flags & 8 ? "zlib" : flags & 1 ? "gzip" : "plaintext";
  const data = bytes.slice(bodyOffset);
  if (data.length > (encoding === "plaintext" ? MAX_SEAL_TEXT_BYTES : MAX_COMPRESSED_BYTES)) throw new Error("Seal text exceeds the 8 MiB limit");
  return {
    version: attested ? "4" : "3", algorithm: "Ed25519", timestamp: new Date(Number(milliseconds)).toISOString(),
    key_id: bytesToHex(bytes.subarray(13, 21)), pdf,
    page_number: pdf ? pageNumber : null, page_count: pdf ? pageCount : null,
    document_root: multiple ? bytesToHex(bytes.subarray(25, 57)) : null,
    signature: bytes.slice(signatureOffset, bodyOffset), encoding, data,
    ...(attested ? { identity } : {}),
    ...(flags & 16 ? { page_evidence: true } : {}),
  };
}

export function encodeChunk(digest, index, count, data, version = "3") {
  if (digest.length !== 32 || !Number.isInteger(index) || !Number.isInteger(count) || count < 2 || count > MAX_CHUNKS || index < 0 || index >= count || !data.length) throw new Error("Invalid chunk index/count");
  const header = new Uint8Array(CHUNK_HEADER_BYTES);
  header.set(version === "4" ? ATTESTED_CHUNK_MAGIC : CHUNK_MAGIC);
  header.set(digest, 4);
  const view = new DataView(header.buffer);
  view.setUint16(36, index);
  view.setUint16(38, count);
  return concatenate([header, data]);
}

export function decodeTransport(bytes) {
  if (bytes.length > MAX_QR_PAYLOAD_BYTES) throw new Error("Seal exceeds QR capacity");
  if (hasMagic(bytes, RECORD_MAGIC) || hasMagic(bytes, ATTESTED_MAGIC)) {
    const envelope = decodeEnvelope(bytes);
    return { ...envelope, format_id: `QRED${envelope.version}`, document_id: `S-${encodeBase64Url(envelope.signature)}`,
      chunk_number: 0, total_chunks: 1, multipart: false, bytes };
  }
  const attested = hasMagic(bytes, ATTESTED_CHUNK_MAGIC);
  if ((!attested && !hasMagic(bytes, CHUNK_MAGIC)) || bytes.length <= CHUNK_HEADER_BYTES) throw new Error("Unknown or truncated seal format");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const index = view.getUint16(36), count = view.getUint16(38);
  if (count < 2 || count > MAX_CHUNKS || index >= count) throw new Error("Invalid chunk index/count");
  const digest = bytes.slice(4, 36);
  return { format_id: attested ? "QRED4" : "QRED3", version: attested ? "4" : "3", document_id: `C-${bytesToHex(digest)}`,
    chunk_number: index, total_chunks: count, multipart: true, digest, data: bytes.slice(CHUNK_HEADER_BYTES), bytes };
}

export function sealString(bytes, bootstrapUrl = DEFAULT_BOOTSTRAP_URL) {
  const version = hasMagic(bytes, ATTESTED_MAGIC) || hasMagic(bytes, ATTESTED_CHUNK_MAGIC) ? "4" : "3";
  return `${(bootstrapUrl || DEFAULT_BOOTSTRAP_URL).split("#")[0]}#QRED${version}:${encodeBase64Url(bytes)}`;
}

export function qrPayloadBytes(value) {
  const fragment = value.includes("#") ? value.slice(value.indexOf("#") + 1) : value;
  if (!/^QRED[34]:/.test(fragment)) return utf8.encode(value);
  const encoded = fragment.slice(6);
  if (!encoded || encoded.length > Math.ceil(MAX_QR_PAYLOAD_BYTES / 3) * 4 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid compact seal encoding");
  const bytes = decodeBase64Url(encoded);
  if (encodeBase64Url(bytes) !== encoded) throw new Error("Invalid compact seal encoding");
  if (bytes[3] !== fragment.charCodeAt(4)) throw new Error("Seal version does not match its framing");
  return bytes;
}

export function qrPayloadText(bytes) {
  if (hasMagic(bytes, RECORD_MAGIC) || hasMagic(bytes, CHUNK_MAGIC) || hasMagic(bytes, ATTESTED_MAGIC) || hasMagic(bytes, ATTESTED_CHUNK_MAGIC)) {
    decodeTransport(bytes);
    return sealString(bytes);
  }
  return strictUtf8.decode(bytes);
}
