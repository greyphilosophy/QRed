/**
 * qredVerifier.js — verify and decode QRed seal strings
 *
 * Refactored: low-level QR sampling, framing, and text diff now live in src/qr/*
 * This file keeps only seal parsing, signature verification, and the public API facade.
 */
import { decodePageEvidence } from "./pageEvidence.js";
import Utils from "qrcode/lib/core/utils.js";
import ECCode from "qrcode/lib/core/error-correction-code.js";
import ECLevel from "qrcode/lib/core/error-correction-level.js";
import { verifyAsync as verifyEd25519 } from "@noble/ed25519";
import { decompressBytes, MAX_SEAL_TEXT_BYTES } from "./sealCompression.js";
import { computeKeyId, decodeBase64Url, sealSignatureMessage } from "./sealSignature.js";
import { bytesEqual, bytesToHex, concatenate, decodeEnvelope, decodeTransport, MAX_ENVELOPE_BYTES,
  qrPayloadBytes, sha256, strictUtf8 } from "./sealFormat.js";
import { VISIBLE_QR_TEXT, extractHiddenQRedPayload, hiddenPayloadByteOffset, hiddenPayloadFromScanResult } from "./qr/hiddenPayload.js";
import { codewordsFromMatrix, deinterleaveDataCodewordsWithQrLib } from "./qr/qrLowLevel.js";
import { sampleQrMatrix } from "./qr/qrImageRecovery.js";
import { tokenizeDocumentText, compareWordSequences, compareDocumentText } from "./qr/qrTextDiff.js";
import { attestationMessage, pageCommitment } from "./attestation.js";
import trustedAuthorities from "./trustedAuthorities.json";

export { VISIBLE_QR_TEXT, extractHiddenQRedPayload, hiddenPayloadByteOffset, tokenizeDocumentText, compareWordSequences, compareDocumentText };

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
  const visibleText = scanResult.data || "";
  const hiddenPayload = hiddenPayloadFromScanResult(scanResult);
  if (visibleText === VISIBLE_QR_TEXT || /QRED[34]:/.test(visibleText) || visibleText.includes("qred.org")) {
    return hiddenPayload || visibleText;
  }
  return visibleText;
}

export function qredDisplayTextFromScannedPayload(payload) {
  const decoded = decodeSeal(payload);
  if (decoded?.encoding === "plaintext" && !decoded.multipart) {
    try { return decoded.page_evidence ? decodePageEvidence(decoded.data).text : strictUtf8.decode(decoded.data); } catch { return payload || ""; }
  }
  return payload || "";
}

// ── Optimized hidden payload recovery from photo geometry
// Fast path: try 0.5/0.5 center first (covers >90% of clean photos), only fall back to grid sweep on noisy photos.
function buildSampleOptions() {
  const thresholds = [undefined, 128, 96, 112, 144, 160];
  const offsets = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65];
  const options = [];
  for (const threshold of thresholds) {
    for (const rowOffset of offsets) {
      for (const colOffset of offsets) {
        const opt = { rowOffset, colOffset };
        if (threshold !== undefined) opt.threshold = threshold;
        options.push(opt);
      }
    }
  }
  return options;
}

const ALL_SAMPLE_OPTIONS = buildSampleOptions();

function deinterleaveWithQrLib(interleaved, version, ecLevelBits = 0) {
  return deinterleaveDataCodewordsWithQrLib(interleaved, version, ecLevelBits, { Utils, ECCode, ECLevel });
}

export function extractHiddenQRedPayloadFromImage(imageData, width, height, scanResult) {
  // Use the decoder's corrected stream before considering legacy image
  // sampling. A missing/malformed payload here must not fall back to raw bits.
  if (scanResult?.correctedData !== undefined) return hiddenPayloadFromScanResult(scanResult);
  if (!scanResult?.location || !scanResult.version) return null;

  // Fast path — single centered adaptive sample
  {
    const matrix = sampleQrMatrix(imageData, width, height, scanResult.location, scanResult.version, { rowOffset: 0.5, colOffset: 0.5 });
    const { codewords, ecLevelBits } = codewordsFromMatrix(matrix, scanResult.version);
    const payload = extractHiddenQRedPayload(deinterleaveWithQrLib(codewords, scanResult.version, ecLevelBits), scanResult.version);
    if (payload) return payload;
  }

  // Fallback sweep with early-exit: agree 2 frames = done
  const counts = new Map();
  for (const options of ALL_SAMPLE_OPTIONS) {
    if (options.threshold === undefined && options.rowOffset === 0.5 && options.colOffset === 0.5) continue;

    const matrix = sampleQrMatrix(imageData, width, height, scanResult.location, scanResult.version, options);
    const { codewords, ecLevelBits } = codewordsFromMatrix(matrix, scanResult.version);
    const payload = extractHiddenQRedPayload(deinterleaveWithQrLib(codewords, scanResult.version, ecLevelBits), scanResult.version);
    if (!payload) continue;

    const nextCount = (counts.get(payload) || 0) + 1;
    counts.set(payload, nextCount);
    if (nextCount >= 2) return payload; // quorum
  }

  // best-effort single vote
  let bestPayload = null;
  let bestCount = 0;
  for (const [payload, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestPayload = payload;
    }
  }
  return bestPayload;
}

export function qredTextFromPhotoScanResult(imageData, width, height, scanResult) {
  const visibleText = qredTextFromScanResult(scanResult);
  if (!imageData || !width || !height) return qredDisplayTextFromScannedPayload(visibleText);
  const hiddenPayload = extractHiddenQRedPayloadFromImage(imageData, width, height, scanResult) || visibleText;
  return qredDisplayTextFromScannedPayload(hiddenPayload);
}

// Like qredTextFromPhotoScanResult, but returns the raw QRed hidden payload (seal string)
// instead of decoding it into plaintext document content.
export function qredPayloadFromPhotoScanResult(imageData, width, height, scanResult) {
  const visibleText = qredTextFromScanResult(scanResult);
  if (!imageData || !width || !height || scanResult?.data !== VISIBLE_QR_TEXT) return visibleText;
  return extractHiddenQRedPayloadFromImage(imageData, width, height, scanResult) || visibleText;
}

// ── Seal parsing + signature verification ──
export function decodeSeal(sealString) {
  if (typeof sealString !== "string") return null;
  const fragment = sealString.includes("#") ? sealString.slice(sealString.indexOf("#") + 1) : sealString;
  if (!/^QRED[34]:/.test(fragment)) return null;
  try { return decodeTransport(qrPayloadBytes(sealString)); } catch { return null; }
}

export async function verifyQRedSeals(seals, publicKey, authorities = trustedAuthorities) {
  if (!Array.isArray(seals) || !seals.length) return { status: "ERROR", error_message: "No valid chunks found" };
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
  if (missing.length) return { status: "INCOMPLETE", document_id: first.document_id,
    collected_chunks: chunks.size, total_chunks: first.total_chunks, error_message: `Missing chunks: [${missing.join(", ")}]` };
  let metadata = first, content, body, evidence;
  try {
    if (first.multipart) {
      const record = concatenate(Array.from({ length: first.total_chunks }, (_, index) => chunks.get(index).data));
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

// Re-export kept for test compatibility (module::codewordsFromMatrix etc were re-exported)
export { sampleQrMatrix, codewordsFromMatrix };

// Back-compat — these used to be re-exported directly from qredVerifier
export function deinterleaveDataCodewords(interleaved, version, ecLevelBits = 0) {
  return deinterleaveDataCodewordsWithQrLib(interleaved, version, ecLevelBits, { Utils, ECCode, ECLevel });
}
