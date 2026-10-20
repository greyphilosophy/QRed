import { decodeBase64Url, encodeBase64Url } from "./sealSignature.js";

// Bound both generated text and untrusted decompression output per sealed page.
export const MAX_SEAL_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = MAX_SEAL_TEXT_BYTES + 65536;
const GZIP_CARRIER_MAGIC = new Uint8Array([0x51, 0x52, 0x47, 0x31]); // QRG1
const textEncoder = new TextEncoder();
// Preserve a leading U+FEFF: it is part of the signed text, not a file marker.
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function concatenate(parts, length) {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

async function transform(bytes, Stream, limit, inputChunkSize) {
  let offset = 0;
  const input = new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + inputChunkSize, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
  const reader = input.pipeThrough(new Stream("gzip")).getReader();
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new Error("Seal text exceeds the 8 MiB limit");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return concatenate(parts, length);
}

export async function gzipText(text) {
  const bytes = textEncoder.encode(text);
  if (bytes.length > MAX_SEAL_TEXT_BYTES) throw new Error("Seal text exceeds the 8 MiB limit");
  if (typeof CompressionStream !== "function") throw new Error("Gzip compression is not available in this browser");
  return transform(bytes, CompressionStream, MAX_COMPRESSED_BYTES, 65536);
}

export function decodeGzipChunk(value) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid gzip chunk encoding");
  const bytes = decodeBase64Url(value);
  if (encodeBase64Url(bytes) !== value) throw new Error("Invalid gzip chunk encoding");
  return bytes;
}

export async function gunzipChunks(chunks) {
  if (typeof DecompressionStream !== "function") throw new Error("Gzip decompression is not available in this browser");
  const parts = [];
  let length = 0;
  for (const chunk of chunks) {
    if (chunk.length > Math.ceil((MAX_COMPRESSED_BYTES - length) / 3) * 4) throw new Error("Compressed seal exceeds the size limit");
    const part = decodeGzipChunk(chunk);
    length += part.length;
    if (length > MAX_COMPRESSED_BYTES) throw new Error("Compressed seal exceeds the size limit");
    parts.push(part);
  }
  // The native gzip decoder validates the stream, CRC32, and original length.
  // Feed small input blocks so output limits can stop an expanding stream
  // before the native decoder processes the entire compressed input.
  const bytes = await transform(concatenate(parts, length), DecompressionStream, MAX_SEAL_TEXT_BYTES, 1024);
  return textDecoder.decode(bytes);
}

function gzipUrlParts(value) {
  const index = value.indexOf("QRED1?");
  if (index < 0 || (index > 0 && value[index - 1] !== "#")) return null;
  const params = new URLSearchParams(value.slice(index + 6));
  if (params.get("rc") !== "gzip") return null;
  if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) throw new Error("Duplicate gzip seal field");
  return { prefix: value.slice(0, index + 6), params };
}

// Manual entry uses a URL with Base64URL text. Inside the actual QR, carry the
// same metadata followed by raw compressed bytes, avoiding Base64 expansion.
export function qrPayloadBytes(value) {
  const parsed = gzipUrlParts(value);
  if (!parsed) return textEncoder.encode(value);
  const body = decodeGzipChunk(parsed.params.get("txt"));
  parsed.params.delete("txt");
  const metadata = textEncoder.encode(parsed.prefix + parsed.params.toString());
  if (metadata.length > 65535) throw new Error("Gzip seal metadata is too large");
  return concatenate([
    GZIP_CARRIER_MAGIC,
    new Uint8Array([metadata.length >>> 8, metadata.length & 255]),
    metadata, body,
  ], 6 + metadata.length + body.length);
}

export function qrPayloadText(bytes) {
  if (!GZIP_CARRIER_MAGIC.every((byte, index) => bytes[index] === byte)) return textDecoder.decode(bytes);
  const metadataLength = (bytes[4] << 8) | bytes[5];
  const bodyOffset = 6 + metadataLength;
  if (bytes.length < 7 || !metadataLength || bodyOffset >= bytes.length) throw new Error("Truncated gzip carrier");
  const metadata = textDecoder.decode(bytes.subarray(6, bodyOffset));
  const parsed = gzipUrlParts(metadata);
  if (!parsed || parsed.params.has("txt")) throw new Error("Invalid gzip carrier metadata");
  parsed.params.set("txt", encodeBase64Url(bytes.subarray(bodyOffset)));
  return parsed.prefix + parsed.params.toString();
}
