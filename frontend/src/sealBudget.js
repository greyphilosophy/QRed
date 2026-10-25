import { MAX_ENCODED_IDENTITY_BYTES } from "./attestation.js";
import { CHUNK_HEADER_BYTES, MAX_QR_PAYLOAD_BYTES, sealEnvelopeOverhead } from "./sealFormat.js";

export const MAX_PDF_SEALS = 2;
export function recordCapacity(count) {
  return count === 1 ? MAX_QR_PAYLOAD_BYTES : count * (MAX_QR_PAYLOAD_BYTES - CHUNK_HEADER_BYTES);
}
export function recordQrCount(length) {
  return length <= MAX_QR_PAYLOAD_BYTES ? 1 : Math.ceil(length / (MAX_QR_PAYLOAD_BYTES - CHUNK_HEADER_BYTES));
}

// The account identity is unknown when the page commitment is bound. Reserve
// its maximum size and omit optional evidence when the QR count is uncertain.
export function evidenceBodyBudget(baseLength, { attested = false, multiple = false } = {}) {
  const minimum = sealEnvelopeOverhead({ attested, multiple });
  const maximum = sealEnvelopeOverhead({ attested, multiple, identityBytes: MAX_ENCODED_IDENTITY_BYTES });
  if (baseLength + maximum <= recordCapacity(1)) return recordCapacity(1) - maximum;
  if (baseLength + minimum <= recordCapacity(1)) return 0;
  const limit = recordCapacity(MAX_PDF_SEALS) - maximum;
  return baseLength <= limit ? limit : 0;
}
