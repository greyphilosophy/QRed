import { signAsync as signEd25519 } from "@noble/ed25519";
import pako from "pako";

export const DEFAULT_BOOTSTRAP_URL = "https://qred.org/";
export const MAX_QR_PAYLOAD_LENGTH = 1200;
const LEGACY_CHUNK_SIZE = 200;

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fragmentBase(bootstrapUrl) {
  const base = bootstrapUrl || DEFAULT_BOOTSTRAP_URL;
  return base.includes("#") ? base.slice(0, base.indexOf("#")) : base;
}

function buildFragmentData({ payload, chunkText, chunkNumber, totalChunks }) {
  const params = new URLSearchParams();
  params.set("v", payload.version);
  params.set("alg", payload.algorithm);
  params.set("doc", payload.document_id);
  params.set("i", String(chunkNumber));
  params.set("n", String(totalChunks));
  params.set("iss", payload.issuer);
  params.set("kid", payload.key_id);
  params.set("ts", payload.timestamp);
  if (chunkNumber === 0) params.set("sig", payload.signature);
  params.set("txt", chunkText);
  return `QRED1?${params.toString()}`;
}

function buildFragmentUrl(bootstrapUrl, fragmentData) {
  return `${fragmentBase(bootstrapUrl)}#${fragmentData}`;
}

function splitTextForQrUrls(canonical, payload, bootstrapUrl) {
  if (!canonical) {
    return [""];
  }

  let totalChunks = 1;
  let chunks = [];
  let stable = false;

  while (!stable) {
    chunks = [];
    let offset = 0;
    while (offset < canonical.length) {
      let low = 1;
      let high = canonical.length - offset;
      let best = 0;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const chunkText = canonical.slice(offset, offset + mid);
        const fragmentData = buildFragmentData({
          payload,
          chunkText,
          chunkNumber: chunks.length,
          totalChunks,
        });
        if (buildFragmentUrl(bootstrapUrl, fragmentData).length <= MAX_QR_PAYLOAD_LENGTH) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (best === 0) {
        throw new Error("QRed metadata and signature exceed the QR payload limit before adding document text");
      }
      chunks.push(canonical.slice(offset, offset + best));
      offset += best;
    }
    stable = chunks.length === totalChunks;
    totalChunks = chunks.length;
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

export async function computeKeyId(publicKey) {
  const digest = await crypto.subtle.digest("SHA-256", decodeBase64Url(publicKey));
  return bytesToHex(new Uint8Array(digest)).slice(0, 16);
}

export function generateDocumentId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `DOC-${bytesToHex(bytes).toUpperCase()}`;
}

export async function createQRedSeals({
  content,
  issuer,
  privateKey,
  publicKey,
  documentId = generateDocumentId(),
  bootstrapUrl = DEFAULT_BOOTSTRAP_URL,
}) {
  const canonical = canonicalizeText(content);
  const signature = await signEd25519(new TextEncoder().encode(canonical), decodeBase64Url(privateKey));
  const keyId = await computeKeyId(publicKey);
  const payload = {
    algorithm: "Ed25519",
    content: canonical,
    document_id: documentId,
    issuer,
    key_id: keyId,
    signature: encodeBase64Url(signature),
    timestamp: new Date().toISOString(),
    version: "1",
  };
  const payloadJson = JSON.stringify(payload, Object.keys(payload).sort());
  const plaintextChunks = splitTextForQrUrls(canonical, payload, bootstrapUrl);
  const compressedSeals = createLegacyQRedSeals(payload, documentId);
  const useCompressed = compressedSeals.length < plaintextChunks.length;
  const seals = useCompressed
    ? compressedSeals
    : plaintextChunks.map((chunkText, index) => buildFragmentUrl(
        bootstrapUrl,
        buildFragmentData({ payload, chunkText, chunkNumber: index, totalChunks: plaintextChunks.length }),
      ));

  return {
    bootstrap_url: fragmentBase(bootstrapUrl),
    document_id: documentId,
    issuer,
    key_id: keyId,
    payload_json: payloadJson,
    seals,
    total_seals: seals.length,
    encoding: useCompressed ? "compressed" : "plaintext",
  };
}

export function createLegacyQRedSeals(payload, documentId) {
  const payloadJson = JSON.stringify(payload, Object.keys(payload).sort());
  const compressed = encodeBase64Url(pako.gzip(payloadJson));
  const chunks = [];
  for (let index = 0; index < compressed.length; index += LEGACY_CHUNK_SIZE) {
    chunks.push(compressed.slice(index, index + LEGACY_CHUNK_SIZE));
  }
  return chunks.map((chunk, index) => `QRED1|${documentId}|${index}|${chunks.length}|${chunk}`);
}
