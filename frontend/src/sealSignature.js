import { bytesToHex, concatenate, decodeBase64Url, encodeMetadata, sha256, utf8 } from "./sealFormat.js";

export { encodeBase64Url, decodeBase64Url } from "./sealFormat.js";

// Version and Ed25519 are fixed by the domain. Compression and chunk boundaries
// are transport details; timestamp, key ID, page context, and text are signed.
export function sealSignatureMessage(metadata, content) {
  return concatenate([utf8.encode("QRed signed document v3\0"), encodeMetadata(metadata), utf8.encode(content)]);
}

export async function computeKeyId(publicKey) {
  const bytes = decodeBase64Url(publicKey);
  if (bytes.length !== 32) throw new Error("An Ed25519 public key must contain 32 bytes");
  return bytesToHex((await sha256(bytes)).subarray(0, 8));
}
