import { concatenate, decodeBase64Url, encodeBase64Url, encodeMetadata, hexToBytes, sha256, signedContentBytes, strictUtf8, utf8 } from "./sealFormat.js";
import { IDENTITY_PROVIDERS } from "./authProviders.js";

export const MAX_ATTESTATION_PAGES = 100;
const IDENTITY_LIMITS = { email: 254, name: 160, subject: 255 };
export const MAX_ENCODED_IDENTITY_BYTES = 8 + Object.values(IDENTITY_LIMITS).reduce((sum, size) => sum + size, 0);
const COMMITMENT_DOMAIN = new TextEncoder().encode("QRed private page commitment v1\0");
const SIGNATURE_DOMAIN = new TextEncoder().encode("QRed Google document attestation v1\0");
const ACCOUNT_SIGNATURE_DOMAIN = new TextEncoder().encode("QRed account document attestation v1\0");

function field(value, maximum) {
  // eslint-disable-next-line no-control-regex -- Reject controls and directional overrides in displayed identity fields.
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new Error("Invalid attestation identity");
  const bytes = utf8.encode(value);
  if (bytes.length > maximum) throw new Error("Attestation identity is too long");
  const length = new Uint8Array(2);
  new DataView(length.buffer).setUint16(0, bytes.length);
  return concatenate([length, bytes]);
}

export function encodeIdentity(identity) {
  const provider = IDENTITY_PROVIDERS[identity?.provider];
  if (!provider || ![identity.provider, "self"].includes(identity.name_source) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(identity.email)) throw new Error("Invalid attestation identity");
  return concatenate([new Uint8Array([provider.id, identity.name_source === identity.provider ? 1 : 0]),
    field(identity.email, IDENTITY_LIMITS.email), field(identity.name, IDENTITY_LIMITS.name), field(identity.subject, IDENTITY_LIMITS.subject)]);
}

export function decodeIdentity(bytes, offset = 0) {
  const start = offset;
  const providerId = bytes[offset++];
  const provider = Object.keys(IDENTITY_PROVIDERS).find(name => IDENTITY_PROVIDERS[name].id === providerId);
  if (!provider || ![0, 1].includes(bytes[offset])) throw new Error("Unsupported attestation identity");
  const name_source = bytes[offset++] === 1 ? provider : "self";
  const read = () => {
    if (offset + 2 > bytes.length) throw new Error("Truncated attestation identity");
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0);
    offset += 2;
    if (offset + size > bytes.length) throw new Error("Truncated attestation identity");
    const value = strictUtf8.decode(bytes.subarray(offset, offset + size));
    offset += size;
    return value;
  };
  const identity = { provider, name_source, email: read(), name: read(), subject: read() };
  if (encodeIdentity(identity).length !== offset - start) throw new Error("Invalid attestation identity");
  return { identity, offset };
}

export async function pageCommitment(metadata, content, salt) {
  if (!(salt instanceof Uint8Array) || salt.length !== 32) throw new Error("Invalid commitment salt");
  // The server never receives the salt, text/visual page body, or unsalted root.
  // Page position/count and the complete-document root are inside this hash.
  const context = encodeMetadata({ ...metadata, timestamp: "1970-01-01T00:00:00.000Z", key_id: "0000000000000000" });
  return sha256(concatenate([COMMITMENT_DOMAIN, salt, context.subarray(0, 1), context.subarray(17), signedContentBytes(content)]));
}

export function attestationMessage({ timestamp, key_id, identity }, commitment) {
  if (!(commitment instanceof Uint8Array) || commitment.length !== 32) throw new Error("Invalid page commitment");
  const time = new Uint8Array(8);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new Error("Invalid attestation timestamp");
  new DataView(time.buffer).setBigUint64(0, BigInt(milliseconds));
  // Keep the original domain for already issued Google attestations.
  const domain = identity?.provider === "google" ? SIGNATURE_DOMAIN : ACCOUNT_SIGNATURE_DOMAIN;
  return concatenate([domain, time, hexToBytes(key_id, 8), encodeIdentity(identity), commitment]);
}

export function decodeFixedBase64(value, length) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoded value");
  const bytes = decodeBase64Url(value);
  if (bytes.length !== length || encodeBase64Url(bytes) !== value) throw new Error("Invalid encoded value");
  return bytes;
}
