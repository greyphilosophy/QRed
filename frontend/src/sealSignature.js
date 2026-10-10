// The QRED1 carrier remains unchanged; v=2 signs this domain-separated envelope.
// Transport recipes and chunk boundaries may change, but the restored content
// and every identity field must agree before a seal is considered VALID.
export function sealSignatureMessage(metadata, content) {
  return new TextEncoder().encode(JSON.stringify([
    "QRed signed document", metadata.version, metadata.algorithm,
    metadata.document_id, metadata.issuer, metadata.key_id, metadata.timestamp,
    content,
  ]));
}

export function decodeBase64Url(value) {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export async function computeKeyId(publicKey) {
  const bytes = decodeBase64Url(publicKey);
  if (bytes.length !== 32) throw new Error("An Ed25519 public key must contain 32 bytes");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
