import { getPublicKeyAsync, keygenAsync } from "@noble/ed25519";
import { decodeBase64Url, encodeBase64Url } from "./sealSignature.js";

export function decodeSigningKey(value, kind) {
  const label = kind === "private" ? "Private key" : "Public key";
  const format = kind === "private" ? "32-byte Ed25519 seed" : "32-byte Ed25519 public key";
  const invalid = () => new Error(`${label} must be a Base64URL- or Base64-encoded ${format}. Generate a key pair or paste a raw key, not PEM, SSH, or hex.`);
  const trimmed = typeof value === "string" ? value.trim() : "";
  // Both encodings use 43 characters for a 32-byte key, plus optional padding.
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(trimmed)) throw invalid();
  let bytes;
  try { bytes = decodeBase64Url(trimmed); } catch { throw invalid(); }
  const normalized = trimmed.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (bytes.length !== 32 || encodeBase64Url(bytes) !== normalized) throw invalid();
  return bytes;
}

export async function readSigningKeyFile(file, kind) {
  if (!file) throw new Error("Choose a key text file saved by QRed.");
  // Saved keys are 44 bytes including the newline. Bound accidental selections
  // before reading them, while allowing surrounding whitespace and a UTF-8 BOM.
  if (file.size > 4096) throw new Error("Key files must be small text files (4 KB or less) containing one raw Ed25519 key.");
  // Raw private/public keys have the same encoding. Recognize our export names
  // (including browser duplicate suffixes) to catch the common wrong-file mix-up.
  const exportedKind = /^qred-ed25519-(private|public)-key(?: ?\(\d+\))?\.txt$/i.exec(file.name)?.[1].toLowerCase();
  if (exportedKind && exportedKind !== kind) {
    throw new Error(`This is a QRed ${exportedKind} key file. Choose a ${kind} key file instead.`);
  }
  let text;
  try {
    text = await file.text();
  } catch {
    throw new Error("Could not read the key file. Choose it again from your device.");
  }
  return encodeBase64Url(decodeSigningKey(text, kind));
}

export async function generateSigningKeyPair() {
  if (!globalThis.crypto?.getRandomValues || !globalThis.crypto?.subtle) {
    throw new Error("Secure key generation is unavailable. Open QRed over HTTPS (or localhost) in a browser with Web Crypto support.");
  }
  // The existing signing library uses crypto.getRandomValues for the seed.
  const { secretKey, publicKey } = await keygenAsync();
  return { privateKey: encodeBase64Url(secretKey), publicKey: encodeBase64Url(publicKey) };
}

export async function deriveSigningPublicKey(privateKey) {
  return encodeBase64Url(await getPublicKeyAsync(decodeSigningKey(privateKey, "private")));
}

export async function validateSigningKeyPair({ privateKey, publicKey }) {
  const privateBytes = decodeSigningKey(privateKey, "private");
  const publicBytes = decodeSigningKey(publicKey, "public");
  const derivedPublicKey = await getPublicKeyAsync(privateBytes);
  if (publicBytes.some((byte, index) => byte !== derivedPublicKey[index])) {
    throw new Error("The public key does not match the private key. Derive the public key from your private key, or generate a new pair.");
  }
  return { privateBytes, publicBytes };
}
