import { signAsync as signEd25519 } from "@noble/ed25519";
import { qredPayloadCapacity } from "./qredQr.js";
import { gzipText } from "./sealCompression.js";
import { computeKeyId, sealSignatureMessage } from "./sealSignature.js";
import { deriveSigningPublicKey, validateSigningKeyPair } from "./signingKeys.js";
import { attestationMessage, pageCommitment, decodeFixedBase64 } from "./attestation.js";
import { verifyAsync } from "@noble/ed25519";
import { CHUNK_HEADER_BYTES, DEFAULT_BOOTSTRAP_URL, MAX_CHUNKS, MAX_SEAL_TEXT_BYTES,
  decodeTransport, encodeBase64Url, encodeChunk, encodeEnvelope, sealString, sha256, utf8 } from "./sealFormat.js";

export { computeKeyId } from "./sealSignature.js";
export { DEFAULT_BOOTSTRAP_URL } from "./sealFormat.js";

async function splitRecord(record, version) {
  if (record.length <= qredPayloadCapacity()) return [record];
  const maximumBody = qredPayloadCapacity() - CHUNK_HEADER_BYTES;
  const count = Math.ceil(record.length / maximumBody);
  if (count > MAX_CHUNKS) throw new Error("Document exceeds the 4096-seal limit");
  const balancedBody = Math.ceil(record.length / count);
  // Keep the minimum code count. Balance only if every grid can be smaller
  // than version 40; otherwise retain the smaller final grid of a greedy split.
  const balance = balancedBody + CHUNK_HEADER_BYTES <= qredPayloadCapacity(39);
  const digest = await sha256(record);
  const chunks = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const length = balance ? Math.ceil((record.length - offset) / (count - index)) : maximumBody;
    chunks.push(encodeChunk(digest, index, count, record.subarray(offset, offset + length), version));
    offset += length;
  }
  return chunks;
}

export function canonicalizeText(text) {
  const collapsed = [];
  let previousEmpty = false;
  for (const line of text.split("\n").map((item) => item.trimEnd())) {
    if (!line) {
      if (!previousEmpty) collapsed.push(line);
      previousEmpty = true;
    } else {
      collapsed.push(line);
      previousEmpty = false;
    }
  }
  while (collapsed.length > 0 && !collapsed[0]) collapsed.shift();
  while (collapsed.length > 0 && !collapsed[collapsed.length - 1]) collapsed.pop();
  return collapsed.join("\n");
}

export async function createQRedSeals({
  content, privateKey, publicKey, pageContext = null, attestation = null,
  timestamp = new Date().toISOString(), bootstrapUrl = DEFAULT_BOOTSTRAP_URL, encodingStrategy = "automatic",
}) {
  const canonical = canonicalizeText(content);
  if (!canonical.trim()) throw new Error("Cannot seal empty document text");
  if (!["automatic", "plaintext", "gzip"].includes(encodingStrategy)) throw new Error(`Unsupported encoding strategy: ${encodingStrategy}`);
  const textBytes = utf8.encode(canonical);
  if (textBytes.length > MAX_SEAL_TEXT_BYTES) throw new Error("Seal text exceeds the 8 MiB limit");
  if (!attestation && !publicKey) publicKey = await deriveSigningPublicKey(privateKey);
  const metadata = {
    version: attestation ? "4" : "3", algorithm: "Ed25519", timestamp: attestation?.timestamp || timestamp,
    key_id: attestation?.key_id || await computeKeyId(publicKey),
    pdf: Boolean(pageContext), page_number: pageContext?.pageNumber ?? null,
    page_count: pageContext?.pageCount ?? null,
    document_root: pageContext?.pageCount > 1 ? pageContext.documentRoot : null,
  };
  let signature;
  if (attestation) {
    Object.assign(metadata, { identity: attestation.identity, salt: attestation.salt });
    signature = decodeFixedBase64(attestation.signature, 64);
    const commitment = await pageCommitment(metadata, canonical, metadata.salt);
    if (await computeKeyId(attestation.public_key) !== metadata.key_id ||
        !await verifyAsync(signature, attestationMessage(metadata, commitment), decodeFixedBase64(attestation.public_key, 32))) {
      throw new Error("QRed attestation does not match this page");
    }
  } else {
    const { privateBytes } = await validateSigningKeyPair({ privateKey, publicKey });
    signature = await signEd25519(sealSignatureMessage(metadata, canonical), privateBytes);
  }
  const candidates = [], failures = [];
  async function addCandidate(encoding, body) {
    try {
      const chunks = await splitRecord(encodeEnvelope(metadata, signature, body, encoding), metadata.version);
      candidates.push({ encoding, chunks, qr_count: chunks.length, payload_bytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0) });
    } catch (error) { failures.push({ encoding, error_message: error.message }); }
  }
  await addCandidate("plaintext", textBytes);
  if (encodingStrategy !== "plaintext" && typeof CompressionStream === "function") {
    await addCandidate("gzip", await gzipText(canonical));
  } else if (encodingStrategy === "gzip") throw new Error("Gzip compression is not available in this browser");
  const selected = encodingStrategy === "automatic"
    ? [...candidates].sort((a, b) => a.qr_count - b.qr_count || a.payload_bytes - b.payload_bytes)[0]
    : candidates.find(item => item.encoding === encodingStrategy);
  if (!selected) throw new Error(failures.find(item => item.encoding === encodingStrategy)?.error_message || failures[0]?.error_message || "No supported seal encoding is available");
  const plaintext = candidates.find(item => item.encoding === "plaintext");
  return {
    ...metadata, bootstrap_url: (bootstrapUrl || DEFAULT_BOOTSTRAP_URL).split("#")[0],
    document_id: decodeTransport(selected.chunks[0]).document_id,
    payload_json: JSON.stringify({ ...metadata, signature: encodeBase64Url(signature), content: canonical }),
    seals: selected.chunks.map(chunk => sealString(chunk, bootstrapUrl)),
    total_seals: selected.qr_count, encoding: selected.encoding, encoding_strategy: encodingStrategy,
    estimated_qr_count: selected.qr_count, payload_bytes: selected.payload_bytes,
    uncompressed_payload_bytes: plaintext?.payload_bytes ?? null,
    compression_savings_pct: plaintext ? Math.round((1 - selected.payload_bytes / plaintext.payload_bytes) * 100) : null,
    candidate_reports: [...candidates.map(({ encoding, qr_count, payload_bytes }) => ({ encoding, qr_count, payload_bytes })), ...failures],
  };
}
