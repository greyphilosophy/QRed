import { signAsync as signEd25519 } from "@noble/ed25519";
import pako from "pako";

export const DEFAULT_BOOTSTRAP_URL = "https://qred.org/verify.htm";
const CHUNK_SIZE = 200;

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  const compressed = encodeBase64Url(pako.gzip(payloadJson));
  const chunks = [];
  for (let index = 0; index < compressed.length; index += CHUNK_SIZE) {
    chunks.push(compressed.slice(index, index + CHUNK_SIZE));
  }
  const seals = chunks.map((chunk, index) => `QRED1|${documentId}|${index}|${chunks.length}|${chunk}`);

  return {
    bootstrap_url: bootstrapUrl,
    document_id: documentId,
    issuer,
    key_id: keyId,
    payload_json: payloadJson,
    seals,
    total_seals: seals.length,
  };
}
