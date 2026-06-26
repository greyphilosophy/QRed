/**
 * qredFragment — Shared utilities for parsing QRed URL fragments.
 *
 * parseQRedSeal: Parses a QRED1? fragment into structured data.
 * isQRedSeal: Checks if a string is a QRED1? seal.
 * decodeFragment: Decodes any URL hash fragment (QRED1? or plain text).
 */

/**
 * Parse a QRED1? URL fragment into structured data.
 * Returns null if not a QRED1? format string.
 * Pass the RAW string to URLSearchParams so %26 (&) survives correctly.
 */
export function parseQRedSeal(raw) {
  if (!raw || typeof raw !== "string" || !raw.startsWith("QRED1?")) {
    return null;
  }
  const params = new URLSearchParams(raw.slice(6));
  return {
    version: params.get("v") || "1",
    text: params.get("txt") || "",
    issuer: params.get("iss") || "",
    documentId: params.get("doc") || "",
    timestamp: params.get("ts") || "",
    keyId: params.get("kid") || "",
    signature: params.get("sig") || "",
    partIndex: params.get("i") || "",
    totalParts: params.get("n") || "",
  };
}

/**
 * Check if a raw string is a QRED1? format seal.
 */
export function isQRedSeal(raw) {
  return typeof raw === "string" && raw.startsWith("QRED1?");
}

/**
 * Decode a URL hash fragment.
 * Returns { type: 'qred1', data: {...} } for QRED1? seals.
 * Returns { type: 'text', text: '...' } for plain text fragments.
 * Returns null if the fragment is empty or undefined.
 */
export function decodeFragment(raw) {
  if (!raw || typeof raw !== "string") return null;
  const fragment = raw.startsWith("#") ? raw.slice(1) : raw;
  if (isQRedSeal(fragment)) {
    return { type: "qred1", data: parseQRedSeal(fragment) };
  }
  if (fragment.length > 0) {
    return { type: "text", text: decodeURIComponent(fragment) };
  }
  return null;
}
