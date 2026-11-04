import { signAsync, verifyAsync } from "@noble/ed25519";
import { decodeEnvelope, encodeEnvelope, qrPayloadBytes, sealString } from "../sealFormat.js";
import { computeKeyId, decodeBase64Url, sealSignatureMessage } from "../sealSignature.js";
import { validateSigningKeyPair } from "../signingKeys.js";
import { decodeErasureChunk, encodeErasureChunks, recoverErasureRecord } from "../erasureTransport.js";
import { decodeExactEvidence, encodeExactEvidence, MAX_EXACT_BODY_BYTES } from "./evidence.js";

// The ordinary QRS3 signature/domain/metadata and QRE transport are unchanged.
// Exact v1 intentionally accepts ONLY uncompressed local-key page bodies.
// Avoid a second decompression policy or account-authority path in this scope.
export async function createExactRecord(manifest, { privateKey, publicKey, timestamp, profile }) {
  const body = encodeExactEvidence(manifest, profile);
  const { privateBytes } = await validateSigningKeyPair({ privateKey, publicKey });
  let metadata, signature;
  try {
    metadata = { version: "3", algorithm: "Ed25519", timestamp, key_id: await computeKeyId(publicKey),
      pdf: true, page_evidence: true, page_number: manifest.page, page_count: manifest.pages,
      document_root: manifest.pages > 1 ? manifest.documentRoot : null };
    signature = await signAsync(sealSignatureMessage(metadata, body), privateBytes);
  } finally { privateBytes.fill(0); }
  const record = encodeEnvelope(metadata, signature, body, "plaintext");
  const shards = await encodeErasureChunks(record, { required: 12, total: 16 });
  return { record, seals: shards.map(bytes => sealString(bytes)), metadata };
}

export async function authenticateExactRecord(seals, publicKey, { profile } = {}) {
  const failure = (signatureStatus, reason) => ({ signatureStatus, reason });
  let record, metadata, observations;
  try {
    if (!Array.isArray(seals) || !seals.length || seals.length > 16 || seals.some(seal => typeof seal !== "string" || seal.length > 8192))
      return failure("UNSUPPORTED", "invalid-seal-collection");
    observations = seals.map(seal => decodeErasureChunk(qrPayloadBytes(seal)));
    if (observations.some(chunk => chunk.version !== "3" || chunk.required_chunks !== 12 || chunk.total_chunks !== 16 ||
        chunk.record_length > MAX_EXACT_BODY_BYTES + 128)) return failure("UNSUPPORTED", "unsupported-exact-transport");
    if (observations.length < 12) return failure("INCOMPLETE", "insufficient-seals");
    record = await recoverErasureRecord(observations.map(chunk => chunk.bytes));
    metadata = decodeEnvelope(record);
    if (metadata.version !== "3" || !metadata.pdf || !metadata.page_evidence || metadata.encoding !== "plaintext" ||
        metadata.data.length > MAX_EXACT_BODY_BYTES) return failure("UNSUPPORTED", "unsupported-exact-envelope");
  } catch { return failure("INVALID", "invalid-seal-record"); }
  if (typeof publicKey !== "string" || !publicKey.trim()) return failure("UNVERIFIED", "trusted-key-required");
  try {
    if (await computeKeyId(publicKey) !== metadata.key_id || !await verifyAsync(metadata.signature,
      sealSignatureMessage(metadata, metadata.data), decodeBase64Url(publicKey))) return failure("INVALID", "signature-failed");
  } catch { return failure("INVALID", "signature-failed"); }
  // No manifest parsing, coordinate allocation, profile dispatch or artwork
  // generation is permitted before this signature succeeds.
  try {
    const manifest = decodeExactEvidence(metadata.data, profile);
    if (metadata.page_number !== manifest.page || metadata.page_count !== manifest.pages ||
        (manifest.pages > 1 ? metadata.document_root !== manifest.documentRoot : metadata.document_root !== null))
      return failure("VALID", "manifest-metadata-mismatch");
    return { signatureStatus: "VALID", manifest, record, metadata };
  } catch { return failure("VALID", "unsupported-or-invalid-exact-evidence"); }
}
