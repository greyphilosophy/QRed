/**
 * qredVerifier.js — verify and decode QRed seal strings
 *
 * Refactored: low-level QR sampling, framing, and text diff now live in src/qr/*
 * This file keeps only seal parsing, signature verification, and the public API facade.
 */
import Utils from "qrcode/lib/core/utils.js";
import ECCode from "qrcode/lib/core/error-correction-code.js";
import ECLevel from "qrcode/lib/core/error-correction-level.js";
import { verifyAsync as verifyEd25519 } from "@noble/ed25519";
import { decodeB45ish } from "./textRecipes.js";
import { computeKeyId, decodeBase64Url, sealSignatureMessage } from "./sealSignature.js";
import { VISIBLE_QR_TEXT, extractHiddenQRedPayload, hiddenPayloadByteOffset } from "./qr/hiddenPayload.js";
import { codewordsFromMatrix, deinterleaveDataCodewordsWithQrLib } from "./qr/qrLowLevel.js";
import { sampleQrMatrix } from "./qr/qrImageRecovery.js";
import { tokenizeDocumentText, compareWordSequences, compareDocumentText } from "./qr/qrTextDiff.js";

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
  const hiddenPayload = extractHiddenQRedPayload(scanResult.binaryData, scanResult.version);
  if (visibleText === VISIBLE_QR_TEXT || visibleText.includes("QRED1") || visibleText.includes("qred.org")) {
    return hiddenPayload || visibleText;
  }
  return visibleText;
}

export function qredDisplayTextFromScannedPayload(payload) {
  const decoded = decodeSeal(payload);
  if (decoded?.recipe === "plaintext" && decoded.data) return decoded.data;
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
async function decodeBrotli(value) {
  if (typeof DecompressionStream !== "function") throw new Error("Brotli decoding is not available in this browser");
  const stream = new Blob([decodeBase64Url(value)]).stream().pipeThrough(new DecompressionStream("br"));
  const buffer = await new Response(stream).arrayBuffer();
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function sealFragment(sealString) {
  const hashIndex = sealString.indexOf("#");
  return hashIndex >= 0 ? sealString.slice(hashIndex + 1) : sealString;
}

function decodePlaintextFragment(fragment) {
  if (!fragment.startsWith("QRED1?")) return null;
  const params = new URLSearchParams(fragment.slice("QRED1?".length));
  if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) return null;
  if (!/^\d+$/.test(params.get("i") || "") || !/^[1-9]\d*$/.test(params.get("n") || "")) return null;
  const chunkNumber = Number(params.get("i"));
  const totalChunks = Number(params.get("n"));
  const documentId = params.get("doc") || "";
  if (!documentId || !Number.isSafeInteger(chunkNumber) || !Number.isSafeInteger(totalChunks) || totalChunks > 4096 || chunkNumber >= totalChunks) return null;

  return {
    format_id: "QRED1",
    document_id: documentId,
    chunk_number: chunkNumber,
    total_chunks: totalChunks,
    data: params.get("txt") || "",
    recipe: params.get("rc") || "plaintext",
    algorithm: params.get("alg") || "Ed25519",
    issuer: params.get("iss") || "",
    key_id: params.get("kid") || "",
    signature: params.get("sig") || "",
    timestamp: params.get("ts") || "",
    version: params.get("v") || "1",
  };
}

export function decodeSeal(sealString) {
  if (typeof sealString !== "string") return null;
  const fragment = sealFragment(sealString);
  const plaintext = decodePlaintextFragment(fragment);
  if (plaintext) return plaintext;
  return null;
}

export async function verifyQRedSeals(seals, publicKey) {
  if (!Array.isArray(seals) || seals.length === 0) {
    return { status: "ERROR", error_message: "No valid chunks found" };
  }
  const chunks = new Map();
  let metadata;
  const consistentFields = ["document_id", "total_chunks", "version", "algorithm", "issuer", "key_id", "timestamp", "recipe"];
  for (const seal of seals) {
    const decoded = decodeSeal(seal);
    if (!decoded) return { status: "ERROR", error_message: "Malformed seal or invalid chunk index/count" };
    if (!metadata) metadata = decoded;
    if (decoded.document_id !== metadata.document_id) {
      return { status: "INVALID", document_id: metadata.document_id, error_message: "Mixed document IDs" };
    }
    if (consistentFields.some((field) => decoded[field] !== metadata[field])) {
      return { status: "INVALID", document_id: metadata.document_id, error_message: "Inconsistent seal metadata" };
    }
    const previous = chunks.get(decoded.chunk_number);
    if (previous && (previous.data !== decoded.data || previous.signature !== decoded.signature)) {
      return { status: "INVALID", document_id: metadata.document_id, error_message: "Conflicting duplicate chunk" };
    }
    if (decoded.chunk_number !== 0 && decoded.signature) {
      return { status: "INVALID", error_message: "Signature must appear only in chunk 0" };
    }
    chunks.set(decoded.chunk_number, decoded);
  }
  if (!["1", "2"].includes(metadata.version) || metadata.algorithm !== "Ed25519") {
    return { status: "ERROR", error_message: "Unsupported seal version or signature algorithm" };
  }
  const missing = [];
  for (let i = 0; i < metadata.total_chunks; i += 1) {
    if (!chunks.has(i)) missing.push(i);
  }
  if (missing.length) {
    return { status: "INCOMPLETE", document_id: metadata.document_id, error_message: `Missing chunks: [${missing.join(", ")}]`, collected_chunks: chunks.size, total_chunks: metadata.total_chunks };
  }
  const recipeDecoders = new Map([
    ["plaintext", (value) => value], ["b45", decodeB45ish],
    ["base45ish", decodeB45ish], ["recipe1", decodeB45ish],
    ["simple_english", decodeB45ish], ["brotli", decodeBrotli],
  ]);
  const decoder = recipeDecoders.get(metadata.recipe);
  if (!decoder) return { status: "ERROR", error_message: "Unsupported text recipe" };
  let content;
  try {
    content = await decoder(Array.from({ length: metadata.total_chunks }, (_, i) => chunks.get(i).data).join(""));
  } catch (error) {
    return { status: "ERROR", error_message: `Recipe decoding failed: ${error.message}` };
  }
  const result = {
    issuer: metadata.issuer, document_id: metadata.document_id,
    timestamp: metadata.timestamp, content, recipe: metadata.recipe,
    key_id: metadata.key_id, version: metadata.version,
    metadata_authenticated: false, signature_valid: false,
  };
  if (!publicKey?.trim()) {
    return { ...result, status: "UNVERIFIED", error_message: "No trusted public key available for signature verification" };
  }
  let isValid;
  try {
    const message = metadata.version === "2"
      ? sealSignatureMessage(metadata, content)
      : new TextEncoder().encode(content);
    const keyMatches = metadata.version === "1" || await computeKeyId(publicKey) === metadata.key_id;
    isValid = keyMatches && await verifyEd25519(decodeBase64Url(chunks.get(0).signature), message, decodeBase64Url(publicKey));
  } catch {
    isValid = false;
  }
  if (!isValid) {
    return { ...result, status: "INVALID", error_message: "Digital signature verification failed" };
  }
  if (metadata.version === "1") {
    return { ...result, status: "LEGACY", signature_valid: true, error_message: "Legacy seal: the content signature matches, but issuer and document metadata are not authenticated. Re-seal to use full verification." };
  }
  return { ...result, status: "VALID", signature_valid: true, metadata_authenticated: true };
}

// Re-export kept for test compatibility (module::codewordsFromMatrix etc were re-exported)
export { sampleQrMatrix, codewordsFromMatrix };

// Back-compat — these used to be re-exported directly from qredVerifier
export function deinterleaveDataCodewords(interleaved, version, ecLevelBits = 0) {
  return deinterleaveDataCodewordsWithQrLib(interleaved, version, ecLevelBits, { Utils, ECCode, ECLevel });
}
