import { concatenate, decodeBase64Url, encodeBase64Url, MAX_COMPRESSED_BYTES, MAX_SEAL_TEXT_BYTES, strictUtf8 as textDecoder, utf8 as textEncoder } from "./sealFormat.js";
export { MAX_SEAL_TEXT_BYTES, qrPayloadBytes, qrPayloadText } from "./sealFormat.js";

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
  return concatenate(parts);
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
    if (chunk.length > (chunk instanceof Uint8Array ? MAX_COMPRESSED_BYTES - length : Math.ceil((MAX_COMPRESSED_BYTES - length) / 3) * 4)) throw new Error("Compressed seal exceeds the size limit");
    const part = chunk instanceof Uint8Array ? chunk : decodeGzipChunk(chunk);
    length += part.length;
    if (length > MAX_COMPRESSED_BYTES) throw new Error("Compressed seal exceeds the size limit");
    parts.push(part);
  }
  // The native gzip decoder validates the stream, CRC32, and original length.
  // Feed small input blocks so output limits can stop an expanding stream
  // before the native decoder processes the entire compressed input.
  const bytes = await transform(concatenate(parts), DecompressionStream, MAX_SEAL_TEXT_BYTES, 1024);
  return textDecoder.decode(bytes);
}
