import { signAsync as signEd25519 } from "@noble/ed25519";
import { createQRedQrData } from "./qredQr.js";
import { gzipText, MAX_SEAL_TEXT_BYTES, qrPayloadBytes } from "./sealCompression.js";
import { computeKeyId, encodeBase64Url, sealSignatureMessage } from "./sealSignature.js";
import { validateSigningKeyPair } from "./signingKeys.js";

export { computeKeyId } from "./sealSignature.js";

export const DEFAULT_BOOTSTRAP_URL = "https://qred.org/";

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fragmentBase(bootstrapUrl) {
  const base = bootstrapUrl || DEFAULT_BOOTSTRAP_URL;
  return base.includes("#") ? base.slice(0, base.indexOf("#")) : base;
}

function buildFragmentData({ payload, chunkText, chunkNumber, totalChunks, encoding = "plaintext" }) {
  const params = new URLSearchParams();
  params.set("v", payload.version);
  params.set("alg", payload.algorithm);
  params.set("doc", payload.document_id);
  params.set("i", String(chunkNumber));
  params.set("n", String(totalChunks));
  params.set("iss", payload.issuer);
  params.set("kid", payload.key_id);
  params.set("ts", payload.timestamp);
  if (encoding === "gzip") params.set("rc", "gzip");
  if (chunkNumber === 0) params.set("sig", payload.signature);
  params.set("txt", chunkText);
  return `QRED1?${params.toString()}`;
}

function buildFragmentUrl(bootstrapUrl, fragmentData) {
  return `${fragmentBase(bootstrapUrl)}#${fragmentData}`;
}

function fragmentFitsQr(bootstrapUrl, fragmentData) {
  try {
    createQRedQrData(buildFragmentUrl(bootstrapUrl, fragmentData));
    return true;
  } catch {
    return false;
  }
}

function splitForQrUrls(data, payload, bootstrapUrl, encoding = "plaintext") {
  let totalChunks = 1;
  // Gzip is split into bytes. Plaintext uses Unicode code points so splitting
  // cannot turn a surrogate pair into replacement characters in a URL.
  const units = encoding === "gzip" ? data : Array.from(data);
  const chunkValue = (start, end) => encoding === "gzip"
    ? encodeBase64Url(units.subarray(start, end))
    : units.slice(start, end).join("");
  let chunks = [];
  let stable = false;

  while (!stable) {
    chunks = [];
    let offset = 0;
    while (offset < units.length) {
      let low = 1;
      let high = Math.min(2945, units.length - offset);
      let best = 0;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const chunkText = chunkValue(offset, offset + mid);
        const fragmentData = buildFragmentData({
          payload,
          chunkText,
          chunkNumber: chunks.length,
          totalChunks,
          encoding,
        });
        if (fragmentFitsQr(bootstrapUrl, fragmentData)) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (best === 0) {
        throw new Error("QRed metadata and signature exceed the QR code capacity before adding document text");
      }
      chunks.push(chunkValue(offset, offset + best));
      if (chunks.length > 4096) throw new Error("Document exceeds the 4096-seal limit");
      offset += best;
    }
    stable = chunks.length === totalChunks;
    totalChunks = chunks.length;
  }

  return chunks.map((chunkText, index) => buildFragmentUrl(
    bootstrapUrl,
    buildFragmentData({ payload, chunkText, chunkNumber: index, totalChunks: chunks.length, encoding }),
  ));
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

export function generateDocumentId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `DOC-${bytesToHex(bytes).toUpperCase()}`;
}

function candidate(encoding, seals) {
  return {
    encoding, seals, qr_count: seals.length,
    payload_bytes: seals.reduce((total, seal) => total + qrPayloadBytes(seal).length, 0),
  };
}

export async function createQRedSeals({
  content,
  issuer,
  privateKey,
  publicKey,
  documentId = generateDocumentId(),
  bootstrapUrl = DEFAULT_BOOTSTRAP_URL,
  encodingStrategy = "automatic",
}) {
  const canonical = canonicalizeText(content);
  if (!canonical.trim()) throw new Error("Cannot seal empty document text");
  if (!issuer?.trim()) throw new Error("An issuer is required");
  if (!["automatic", "plaintext", "gzip"].includes(encodingStrategy)) {
    throw new Error(`Unsupported encoding strategy: ${encodingStrategy}`);
  }
  if (new TextEncoder().encode(canonical).length > MAX_SEAL_TEXT_BYTES) throw new Error("Seal text exceeds the 8 MiB limit");
  if (!documentId) documentId = generateDocumentId();
  const { privateBytes } = await validateSigningKeyPair({ privateKey, publicKey });
  const keyId = await computeKeyId(publicKey);
  const baseFields = {
    algorithm: "Ed25519",
    document_id: documentId,
    issuer,
    key_id: keyId,
    timestamp: new Date().toISOString(),
    version: "2",
  };
  baseFields.signature = encodeBase64Url(await signEd25519(sealSignatureMessage(baseFields, canonical), privateBytes));

  const candidates = [];
  const failures = [];
  function addCandidate(encoding, data) {
    try {
      candidates.push(candidate(encoding, splitForQrUrls(data, baseFields, bootstrapUrl, encoding)));
    } catch (error) {
      failures.push({ encoding, error_message: error.message });
    }
  }
  addCandidate("plaintext", canonical);
  if (encodingStrategy !== "plaintext" && typeof CompressionStream === "function") {
    const compressed = await gzipText(canonical);
    addCandidate("gzip", compressed);
  } else if (encodingStrategy === "gzip") {
    throw new Error("Gzip compression is not available in this browser");
  }
  const selected = encodingStrategy === "automatic"
    ? [...candidates].sort((a, b) => a.qr_count - b.qr_count || a.payload_bytes - b.payload_bytes)[0]
    : candidates.find((item) => item.encoding === encodingStrategy);
  if (!selected) throw new Error(failures.find(item => item.encoding === encodingStrategy)?.error_message || failures[0]?.error_message || "No supported seal encoding is available");
  const plaintext = candidates.find(item => item.encoding === "plaintext");
  const payload = { ...baseFields, content: canonical };

  return {
    bootstrap_url: fragmentBase(bootstrapUrl),
    document_id: documentId,
    issuer,
    key_id: keyId,
    payload_json: JSON.stringify(payload, Object.keys(payload).sort()),
    seals: selected.seals,
    total_seals: selected.qr_count,
    encoding: selected.encoding,
    encoding_strategy: encodingStrategy,
    estimated_qr_count: selected.qr_count,
    payload_bytes: selected.payload_bytes,
    uncompressed_payload_bytes: plaintext?.payload_bytes ?? null,
    compression_savings_pct: plaintext ? Math.round((1 - selected.payload_bytes / plaintext.payload_bytes) * 100) : null,
    candidate_reports: [
      ...candidates.map(({ encoding, qr_count, payload_bytes }) => ({ encoding, qr_count, payload_bytes })),
      ...failures,
    ],
  };
}
