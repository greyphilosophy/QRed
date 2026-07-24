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
import { VISIBLE_QR_TEXT, extractHiddenQRedPayload, hiddenPayloadByteOffset } from "./qr/hiddenPayload.js";
import { codewordsFromMatrix, deinterleaveDataCodewordsWithQrLib } from "./qr/qrLowLevel.js";
import { sampleQrMatrix } from "./qr/qrImageRecovery.js";
import { tokenizeDocumentText, compareWordSequences, compareDocumentText } from "./qr/qrTextDiff.js";

export { VISIBLE_QR_TEXT, extractHiddenQRedPayload, hiddenPayloadByteOffset, tokenizeDocumentText, compareWordSequences, compareDocumentText };

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
  if (!imageData || !width || !height) return visibleText;
  return extractHiddenQRedPayloadFromImage(imageData, width, height, scanResult) || visibleText;
}

// ── Seal parsing + signature verification ──
function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

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
  const chunkNumber = Number.parseInt(params.get("i") || "", 10);
  const totalChunks = Number.parseInt(params.get("n") || "", 10);
  const documentId = params.get("doc") || "";
  if (!documentId || !Number.isInteger(chunkNumber) || !Number.isInteger(totalChunks)) return null;

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
  const fragment = sealFragment(sealString);
  const plaintext = decodePlaintextFragment(fragment);
  if (plaintext) return plaintext;
  return null;
}

export async function verifyQRedSeals(seals, publicKey) {
  const context = { chunks: {}, document_id: "", total_chunks: 0, errors: [], plaintext: false, metadata: {} };

  for (const seal of seals) {
    const decoded = decodeSeal(seal);
    if (!decoded) {
      context.errors.push(`Malformed seal: ${seal.slice(0, 50)}`);
      continue;
    }

    if (context.document_id && decoded.document_id !== context.document_id) {
      return { status: "INVALID", document_id: context.document_id, error_message: "Mixed document IDs" };
    }

    if (!context.document_id) context.document_id = decoded.document_id;
    context.total_chunks = decoded.total_chunks;
    context.chunks[decoded.chunk_number] = decoded.data;
    if (decoded.recipe !== undefined) {
      context.plaintext = true;
      context.metadata = { ...context.metadata, recipe: decoded.recipe };
    }
    if (decoded.recipe !== undefined || decoded.algorithm) {
      context.metadata = {
        ...context.metadata,
        ...Object.fromEntries(
          Object.entries({
            algorithm: decoded.algorithm,
            issuer: decoded.issuer,
            key_id: decoded.key_id,
            signature: decoded.signature,
            timestamp: decoded.timestamp,
            version: decoded.version,
          }).filter(([, value]) => value)
        ),
      };
    }
  }

  const chunkNumbers = Object.keys(context.chunks).map(Number);
  if (chunkNumbers.length === 0) return { status: "ERROR", error_message: "No valid chunks found" };

  const missing = [];
  for (let i = 0; i < context.total_chunks; i += 1) {
    if (!(i in context.chunks)) missing.push(i);
  }
  if (missing.length > 0) {
    return { status: "INCOMPLETE", document_id: context.document_id, error_message: `Missing chunks: [${missing.join(", ")}]` };
  }

  let payload;
  try {
    const rawData = Array.from({ length: context.total_chunks }, (_, i) => context.chunks[i]).join("");
    if (context.plaintext) {
      payload = {
        algorithm: context.metadata.algorithm || "Ed25519",
        content: rawData,
        document_id: context.document_id,
        issuer: context.metadata.issuer || "",
        key_id: context.metadata.key_id || "",
        signature: context.metadata.signature || "",
        timestamp: context.metadata.timestamp || "",
        version: context.metadata.version || "1",
        recipe: context.metadata.recipe || "plaintext",
      };
    } else {
      return { status: "ERROR", error_message: "Unsupported seal format" };
    }
  } catch (error) {
    return { status: "ERROR", error_message: `Payload decoding failed: ${error.message}` };
  }

  const content = payload.content || "";
  const recipe = payload.recipe || "plaintext";
  const recipeDecoders = {
    b45: decodeB45ish,
    base45ish: decodeB45ish,
    recipe1: decodeB45ish,
    simple_english: decodeB45ish,
    brotli: decodeBrotli,
  };
  let restoredContent;
  try {
    restoredContent = await (recipeDecoders[recipe] || ((value) => value))(content);
  } catch (error) {
    return { status: "ERROR", error_message: `Recipe decoding failed: ${error.message}` };
  }
  const signature = payload.signature || "";
  const issuer = payload.issuer || "";
  const documentId = payload.document_id || "";
  const timestamp = payload.timestamp || "";
  const keyId = payload.key_id || "";

  if (!publicKey) {
    return {
      status: "UNVERIFIED",
      document_id: documentId,
      issuer,
      timestamp,
      content: restoredContent,
      recipe,
      key_id: keyId,
      error_message: "No trusted public key available for signature verification",
    };
  }

  let isValid;
  try {
    const message = new TextEncoder().encode(restoredContent);
    isValid = await verifyEd25519(decodeBase64Url(signature), message, decodeBase64Url(publicKey));
  } catch {
    isValid = false;
  }

  if (isValid) {
    return { status: "VALID", issuer, document_id: documentId, timestamp, content: restoredContent, recipe, key_id: keyId };
  }

  return {
    status: "INVALID",
    issuer,
    document_id: documentId,
    error_message: "Digital signature verification failed",
    content: restoredContent,
    recipe,
    key_id: keyId,
  };
}

// Re-export kept for test compatibility (module::codewordsFromMatrix etc were re-exported)
export { sampleQrMatrix, codewordsFromMatrix };

// Back-compat — these used to be re-exported directly from qredVerifier
export function deinterleaveDataCodewords(interleaved, version, ecLevelBits = 0) {
  return deinterleaveDataCodewordsWithQrLib(interleaved, version, ecLevelBits, { Utils, ECCode, ECLevel });
}
