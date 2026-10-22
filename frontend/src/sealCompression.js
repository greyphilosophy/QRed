import { concatenate, decodeBase64Url, encodeBase64Url, MAX_COMPRESSED_BYTES, MAX_SEAL_TEXT_BYTES, strictUtf8 as textDecoder, utf8 as textEncoder } from "./sealFormat.js";
export { MAX_SEAL_TEXT_BYTES, qrPayloadBytes, qrPayloadText } from "./sealFormat.js";

function streamFormat(encoding) {
  if (encoding === "zlib") return "deflate";
  if (encoding === "gzip") return "gzip";
  throw new Error("Unsupported compression encoding");
}

async function transform(bytes, stream, limit, inputChunkSize) {
  let offset = 0;
  const input = new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + inputChunkSize, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
  const reader = input.pipeThrough(stream).getReader();
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

export async function compressText(text, encoding) {
  const format = streamFormat(encoding);
  const bytes = textEncoder.encode(text);
  if (bytes.length > MAX_SEAL_TEXT_BYTES) throw new Error("Seal text exceeds the 8 MiB limit");
  if (typeof CompressionStream !== "function") throw new Error(`${encoding} compression is not available in this browser`);
  // Native "deflate" uses the zlib wrapper (6 bytes), not raw DEFLATE.
  // The browser chooses the compression level for both zlib and gzip.
  return transform(bytes, new CompressionStream(format), MAX_COMPRESSED_BYTES, 65536);
}

function decodeCompressedChunk(value) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid compressed chunk encoding");
  const bytes = decodeBase64Url(value);
  if (encodeBase64Url(bytes) !== value) throw new Error("Invalid compressed chunk encoding");
  return bytes;
}

export async function decompressChunks(chunks, encoding) {
  const format = streamFormat(encoding);
  if (typeof DecompressionStream !== "function") throw new Error(`${encoding} decompression is not available in this browser`);
  const parts = [];
  let length = 0;
  for (const chunk of chunks) {
    if (chunk.length > (chunk instanceof Uint8Array ? MAX_COMPRESSED_BYTES - length : Math.ceil((MAX_COMPRESSED_BYTES - length) / 3) * 4)) throw new Error("Compressed seal exceeds the size limit");
    const part = chunk instanceof Uint8Array ? chunk : decodeCompressedChunk(chunk);
    length += part.length;
    if (length > MAX_COMPRESSED_BYTES) throw new Error("Compressed seal exceeds the size limit");
    parts.push(part);
  }
  // Native decoders validate framing and checksums (Adler-32 for zlib;
  // CRC32 and original length for gzip). Signatures authenticate the text.
  // Feed small input blocks so output limits can stop an expanding stream
  // before the native decoder processes the entire compressed input.
  const bytes = await transform(concatenate(parts), new DecompressionStream(format), MAX_SEAL_TEXT_BYTES, 1024);
  return textDecoder.decode(bytes);
}
