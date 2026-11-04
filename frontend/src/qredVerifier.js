import { recoverErasureRecord } from "./erasureTransport.js";
/**
 * qredVerifier.js — verify and decode QRed seal strings
 *
 * Refactored: low-level QR sampling, framing, and text diff now live in src/qr/*
 * This file keeps only seal parsing, signature verification, and the public API facade.
 */
import { decodePageEvidence } from "./pageEvidence.js";
import { verifyAsync as verifyEd25519 } from "@noble/ed25519";
import { decompressBytes, MAX_SEAL_TEXT_BYTES } from "./sealCompression.js";
import { computeKeyId, decodeBase64Url, sealSignatureMessage } from "./sealSignature.js";
import { bytesEqual, bytesToHex, concatenate, decodeEnvelope, decodeTransport, MAX_ENVELOPE_BYTES,
  qrPayloadBytes, sha256, strictUtf8 } from "./sealFormat.js";
import { qredPayloadFromScanResult } from "./qr/qrPayload.js";
import { tokenizeDocumentText, compareWordSequences, compareDocumentText } from "./qr/qrTextDiff.js";
import { attestationMessage, pageCommitment } from "./attestation.js";
import trustedAuthorities from "./trustedAuthorities.json";

export { tokenizeDocumentText, compareWordSequences, compareDocumentText };

/**
 * classifyOcrWords — given the verified QR text (the expected words) and the
 * OCR word objects from tesseract.js, mark each OCR word as either:
 *  - matched: present in the verified QR word sequence
 *  - extra:   not present in the verified QR word sequence
 *
 * This mirrors the overlay behavior historically implemented in verifier.html.
 */
export function classifyOcrWords(qrText, ocrWords) {
  const qrWords = (qrText || "").match(/\S+/g) || [];
  const pageWords = (ocrWords || []).map((word) => word?.text || "");

  const comparison = compareWordSequences(qrWords, pageWords);

  return {
    words: (ocrWords || []).map((word, index) => ({
      word,
      status: comparison.matchedPage.has(index) ? "matched" : "extra",
    })),
    missing: comparison.missingQrWords,
  };
}

export function qredTextFromScanResult(scanResult) {
  if (!scanResult || typeof scanResult === "string") return scanResult || "";
  return qredPayloadFromScanResult(scanResult) || scanResult.data || "";
}

export function qredDisplayTextFromScannedPayload(payload) {
  const decoded = decodeSeal(payload);
  if (decoded?.encoding === "plaintext" && !decoded.multipart) {
    try { return decoded.page_evidence ? decodePageEvidence(decoded.data).text : strictUtf8.decode(decoded.data); } catch { return payload || ""; }
  }
  return payload || "";
}

// Photo geometry is handled by the QR decoder. Only its corrected message
// bytes are accepted here; the verifier never recovers data from QR padding.
export function qredTextFromPhotoScanResult(_imageData, _width, _height, scanResult) {
  return qredDisplayTextFromScannedPayload(qredTextFromScanResult(scanResult));
}

export function qredPayloadFromPhotoScanResult(_imageData, _width, _height, scanResult) {
  return qredTextFromScanResult(scanResult);
}

// ── Seal parsing + signature verification ──
export function decodeSeal(sealString) {
  if (typeof sealString !== "string") return null;
  const fragment = sealString.includes("#") ? sealString.slice(sealString.indexOf("#") + 1) : sealString;
  if (!/^QRED[34]:/.test(fragment)) return null;
  try { return decodeTransport(qrPayloadBytes(sealString)); } catch { return null; }
}

export async function verifyQRedSeals(seals, publicKey, authorities = trustedAuthorities) {
  if (!Array.isArray(seals) || !seals.length || seals.length > 4096 ||
      seals.some(seal => typeof seal !== "string" || seal.length > 8192) ||
      seals.reduce((sum, seal) => sum + seal.length, 0) > 24 * 1024 * 1024) return { status: "ERROR", error_message: "No valid chunks found" };
  const chunks = new Map();
  let first, length = 0;
  for (const seal of seals) {
    const decoded = decodeSeal(seal);
    if (!decoded) return { status: "ERROR", error_message: "Malformed or unsupported seal. Re-seal older documents with the current format." };
    first ??= decoded;
    if (decoded.version !== first.version || decoded.document_id !== first.document_id || decoded.total_chunks !== first.total_chunks || decoded.multipart !== first.multipart) {
      return { status: "INVALID", document_id: first.document_id, error_message: "Mixed seal sets or inconsistent chunk counts" };
    }
    const previous = chunks.get(decoded.chunk_number);
    if (previous && !bytesEqual(previous.bytes, decoded.bytes)) return { status: "INVALID", error_message: "Conflicting duplicate chunk" };
    if (!previous) length += decoded.data.length;
    if (length > MAX_ENVELOPE_BYTES) return { status: "ERROR", error_message: "Seal exceeds the size limit" };
    chunks.set(decoded.chunk_number, decoded);
  }
  const missing = [];
  for (let index = 0; index < first.total_chunks; index += 1) if (!chunks.has(index)) missing.push(index);
  if (first.erasure ? chunks.size < first.required_chunks : missing.length) return { status: "INCOMPLETE", document_id: first.document_id,
    collected_chunks: chunks.size, total_chunks: first.total_chunks, required_chunks: first.required_chunks,
    error_message: first.erasure ? `Need ${first.required_chunks} distinct erasure shards; collected ${chunks.size}` : `Missing chunks: [${missing.join(", ")}]` };
  let metadata = first, content, body, evidence;
  try {
    if (first.multipart) {
      const record = first.erasure ? await recoverErasureRecord([...chunks.values()].map(chunk => chunk.bytes))
        : concatenate(Array.from({ length: first.total_chunks }, (_, index) => chunks.get(index).data));
      if (!bytesEqual((await sha256(record)).subarray(0, first.digest.length), first.digest)) return { status: "INVALID", error_message: "Seal set digest does not match its contents" };
      metadata = decodeEnvelope(record);
      if (metadata.version !== first.version) throw new Error("Seal version does not match its chunks");
    }
    body = metadata.encoding === "plaintext" ? metadata.data : await decompressBytes([metadata.data], metadata.encoding);
    evidence = metadata.page_evidence ? decodePageEvidence(body) : null;
    content = evidence ? evidence.text : strictUtf8.decode(body);
    if (body.length > MAX_SEAL_TEXT_BYTES) throw new Error("Seal text exceeds the 8 MiB limit");
  } catch (error) { return { status: "ERROR", error_message: `Seal decoding failed: ${error.message}` }; }
  const pageHash = metadata.pdf ? bytesToHex(await sha256(body)) : null;
  const result = {
    ...(evidence ? { evidence } : {}),
    document_id: first.document_id, timestamp: metadata.timestamp, content, encoding: metadata.encoding,
    key_id: metadata.key_id, version: metadata.version, pdf: metadata.pdf,
    page_number: metadata.page_number, page_count: metadata.page_count, page_hash: pageHash,
    document_root: metadata.pdf ? metadata.document_root || pageHash : null,
    metadata_authenticated: false, signature_valid: false,
    ...(metadata.version === "4" ? { identity: metadata.identity, attestation: metadata.identity.provider, identity_authenticated: false } : {}),
  };
  if (metadata.version === "4") publicKey = authorities[metadata.key_id];
  if (!publicKey?.trim()) return { ...result, status: "UNVERIFIED", error_message: "No trusted public key available for signature verification" };
  let isValid = false;
  try {
    const message = metadata.version === "4"
      ? attestationMessage(metadata, await pageCommitment(metadata, body))
      : sealSignatureMessage(metadata, body);
    isValid = await computeKeyId(publicKey) === metadata.key_id &&
      await verifyEd25519(metadata.signature, message, decodeBase64Url(publicKey));
  } catch { /* malformed keys or signatures are invalid */ }
  if (!isValid) return { ...result, status: "INVALID", error_message: "Digital signature verification failed" };
  return { ...result, status: "VALID", signature_valid: true, metadata_authenticated: true,
    ...(metadata.version === "4" ? { identity_authenticated: true } : {}) };
}
