import { MAX_ENCODED_IDENTITY_BYTES } from "./attestation.js";
import { chunkHeaderBytes, MAX_QR_PAYLOAD_BYTES, sealEnvelopeOverhead } from "./sealFormat.js";

// A page can use a 2x2 watermark grid if its signed record exceeds two QRs.
// The placement/preflight and footer-size checks still decide print viability.
export const MAX_PDF_SEALS = 4;
export function recordCapacity(count, attested = false) {
  return count === 1 ? MAX_QR_PAYLOAD_BYTES : count * (MAX_QR_PAYLOAD_BYTES - chunkHeaderBytes(attested ? "4" : "3"));
}
export function recordQrCount(length, version = "3") {
  return length <= MAX_QR_PAYLOAD_BYTES ? 1 : Math.ceil(length / (MAX_QR_PAYLOAD_BYTES - chunkHeaderBytes(version)));
}

// The account identity is unknown when the page commitment is bound. Reserve
// its maximum size and omit optional evidence when the QR count is uncertain.
export function evidenceBodyBudget(baseLength, { attested = false, multiple = false } = {}) {
  const minimum = sealEnvelopeOverhead({ attested, multiple });
  const maximum = sealEnvelopeOverhead({ attested, multiple, identityBytes: MAX_ENCODED_IDENTITY_BYTES });
  if (baseLength + maximum <= recordCapacity(1)) return recordCapacity(1) - maximum;
  if (baseLength + minimum <= recordCapacity(1)) return 0;
  // Optional thumbnails and text coordinates must never turn a two-QR page
  // into three or four QRs merely because more physical slots now exist.
  // Count only the chunks needed by the essential signed text. If the
  // provider's unknown identity could increase that count, omit optional
  // evidence instead of spending a speculative extra QR.
  const needed = recordQrCount(baseLength + minimum, attested ? "4" : "3");
  if (needed > MAX_PDF_SEALS) return 0;
  const limit = recordCapacity(needed, attested) - maximum;
  return baseLength <= limit ? limit : 0;
}
