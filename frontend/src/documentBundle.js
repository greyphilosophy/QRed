import { bytesEqual, CHUNK_HEADER_BYTES, concatenate, decodeEnvelope, decodeTransport, encodeEnvelope,
  MAX_CHUNKS, MAX_ENVELOPE_BYTES, MAX_QR_PAYLOAD_BYTES, MAX_SEAL_TEXT_BYTES, qrPayloadBytes, sealString, sha256 } from "./sealFormat.js";
import { decompressBytes, encodedBodyCandidates, selectBodyEncoding } from "./sealCompression.js";

// The outer transport is not a signature. Each embedded QRS3/QRS4 record keeps
// its original signature, page evidence, identity and document membership.
// Normalize bodies before compression so repeated words across pages can share
// one dictionary instead of recompressing independent compressed streams.
const encodings = ["plaintext", "zlib", "gzip"];
const capacity = MAX_QR_PAYLOAD_BYTES - CHUNK_HEADER_BYTES;

async function pageEnvelope(seals) {
  const chunks = seals.map(seal => decodeTransport(qrPayloadBytes(seal)));
  const first = chunks[0], unique = new Map();
  if (!first || first.document_bundle) throw new Error("Expected signed page seals");
  let length = 0;
  for (const chunk of chunks) {
    if (chunk.document_id !== first.document_id || chunk.version !== first.version ||
        chunk.total_chunks !== first.total_chunks || chunk.multipart !== first.multipart) throw new Error("Mixed page seals");
    const previous = unique.get(chunk.chunk_number);
    if (previous && !bytesEqual(previous.bytes, chunk.bytes)) throw new Error("Conflicting page seals");
    if (!previous) length += chunk.data.length;
    if (length > MAX_ENVELOPE_BYTES) throw new Error("Page seal exceeds the size limit");
    unique.set(chunk.chunk_number, chunk);
  }
  if (unique.size !== first.total_chunks) throw new Error("Incomplete page seals");
  if (!first.multipart) return first;
  const bytes = concatenate(Array.from({ length: first.total_chunks }, (_, index) => unique.get(index).data));
  if (!bytesEqual((await sha256(bytes)).subarray(0, first.digest.length), first.digest)) throw new Error("Page seal digest mismatch");
  const metadata = decodeEnvelope(bytes);
  if (metadata.version !== first.version) throw new Error("Page seal version mismatch");
  return metadata;
}

function checkMembership(pages) {
  const first = pages[0];
  const membership = page => JSON.stringify([page.version, page.key_id, page.timestamp, page.document_root, page.identity]);
  const seen = new Set();
  for (const page of pages) {
    if (!page.pdf || page.page_count !== pages.length || membership(page) !== membership(first) || seen.has(page.page_number)) {
      throw new Error("Document bundle must contain every page of one signing version exactly once");
    }
    seen.add(page.page_number);
  }
}

export async function createDocumentBundle(records) {
  if (!records.length || records.length > 65535) throw new Error("Invalid document page count");
  const pages = [], parts = [], header = new Uint8Array(2);
  new DataView(header.buffer).setUint16(0, records.length);
  parts.push(header);
  let length = header.length;
  for (const { seals } of records) {
    const metadata = await pageEnvelope(seals);
    const body = metadata.encoding === "plaintext" ? metadata.data : await decompressBytes([metadata.data], metadata.encoding);
    const envelope = encodeEnvelope(metadata, metadata.signature, body, "plaintext");
    length += 4 + envelope.length;
    if (length > MAX_SEAL_TEXT_BYTES) throw new Error("Document seal data exceeds the 8 MiB bundle limit");
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, envelope.length);
    parts.push(prefix, envelope);
    pages.push(metadata);
  }
  checkMembership(pages);
  const plain = concatenate(parts);
  const selected = selectBodyEncoding(await encodedBodyCandidates(plain));
  const packet = concatenate([new Uint8Array([encodings.indexOf(selected.encoding)]), selected.body]);
  const digest = await sha256(packet), count = Math.ceil(packet.length / capacity);
  if (count > MAX_CHUNKS) throw new Error("Too many document seals");
  const chunkSize = Math.ceil(packet.length / count);
  const seals = Array.from({ length: count }, (_, index) => {
    const header = new Uint8Array(CHUNK_HEADER_BYTES);
    header.set([81, 82, 68, 53]);
    header.set(digest, 4);
    const view = new DataView(header.buffer);
    view.setUint16(36, index); view.setUint16(38, count);
    return sealString(concatenate([header, packet.subarray(index * chunkSize, (index + 1) * chunkSize)]));
  });
  return { seals, encoding: selected.encoding, uncompressed_bytes: plain.length, payload_bytes: packet.length };
}

// Called only after the complete outer packet's SHA-256 digest is checked.
export async function decodeDocumentBundle(packet) {
  const encoding = encodings[packet[0]];
  if (!encoding || packet.length < 4) throw new Error("Invalid document bundle encoding");
  const bytes = encoding === "plaintext" ? packet.subarray(1) : await decompressBytes([packet.subarray(1)], encoding);
  if (bytes.length > MAX_SEAL_TEXT_BYTES || bytes.length < 2) throw new Error("Invalid document bundle length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(0), pages = [];
  if (!count) throw new Error("Empty document bundle");
  let offset = 2;
  for (let index = 0; index < count; index++) {
    if (offset + 4 > bytes.length) throw new Error("Truncated document bundle");
    const size = view.getUint32(offset); offset += 4;
    if (!size || size > MAX_ENVELOPE_BYTES || size > bytes.length - offset) throw new Error("Invalid bundled page length");
    const metadata = decodeEnvelope(bytes.subarray(offset, offset + size)); offset += size;
    if (metadata.encoding !== "plaintext") throw new Error("Nested compression in document bundle");
    pages.push(metadata);
  }
  if (offset !== bytes.length) throw new Error("Trailing data in document bundle");
  checkMembership(pages);
  return pages.sort((a, b) => a.page_number - b.page_number);
}
