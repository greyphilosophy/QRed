import { MAX_ENCODED_IDENTITY_BYTES } from "../attestation.js";
import { encodePageEvidence, encodeVisualReference } from "../pageEvidence.js";
import { compressBytes } from "../sealCompression.js";
import { CHUNK_HEADER_BYTES, MAX_QR_PAYLOAD_BYTES, utf8 } from "../sealFormat.js";

export async function encodedBodyLength(bytes, strategy = "automatic") {
  if (strategy === "plaintext") return bytes.length;
  if (strategy !== "automatic") return (await compressBytes(bytes, strategy)).length;
  if (typeof CompressionStream !== "function") return bytes.length;
  try { return Math.min(bytes.length, (await compressBytes(bytes, "zlib")).length); }
  catch {
    try { return Math.min(bytes.length, (await compressBytes(bytes, "gzip")).length); }
    catch { return bytes.length; }
  }
}

// Google binds the document commitments before returning the identity. Reserve
// its maximum permitted encoded size (8 + 254 + 160 + 255), rather than let
// optional evidence cause a second code when the real name/email arrives.
export function evidenceBodyBudget(baseLength, { google = false, multiple = false } = {}) {
  const header = 85 + (multiple ? 36 : 0);
  const minimum = header + (google ? 32 : 0);
  const maximum = minimum + (google ? MAX_ENCODED_IDENTITY_BYTES : 0);
  if (baseLength + maximum <= MAX_QR_PAYLOAD_BYTES) return MAX_QR_PAYLOAD_BYTES - maximum;
  if (baseLength + minimum <= MAX_QR_PAYLOAD_BYTES) return 0; // Identity could put this page on either side of the boundary.
  const limit = 2 * (MAX_QR_PAYLOAD_BYTES - CHUNK_HEADER_BYTES) - maximum;
  return baseLength <= limit ? limit : 0;
}

export async function planPageEvidence(page, { google = false, multiple = false, encodingStrategy = "automatic" } = {}) {
  const { text, width, height, lines, image, blank } = page;
  const baseBytes = utf8.encode(text);
  const baseLength = await encodedBodyLength(baseBytes, encodingStrategy);
  const minimumHeader = 85 + (multiple ? 36 : 0) + (google ? 32 : 0);
  if (baseLength + minimumHeader > 2 * (MAX_QR_PAYLOAD_BYTES - CHUNK_HEADER_BYTES)) {
    throw new Error(`PDF page ${page.pageNumber || 1} exceeds the two-QR limit. Shorten the page or split its content across pages.`);
  }
  const budget = evidenceBodyBudget(baseLength, { google, multiple });
  if (text && !budget) return { ...page, image: undefined, body: baseBytes, pageEvidence: null };
  const record = { text, width, height, blank };
  const fits = async evidence => {
    const bytes = encodePageEvidence(evidence);
    return await encodedBodyLength(bytes, encodingStrategy) <= budget ? bytes : null;
  };
  if (blank) {
    const body = encodePageEvidence(record);
    return { ...page, image: undefined, body, pageEvidence: body };
  }
  let chosen = null;
  if (text && lines.length && lines.length <= 65535) {
    // Spend on useful text coordinates first: boxes, byte coordinates, then
    // one-byte 16x16 line-start cells. Omit them altogether if nothing fits.
    for (const mode of [3, 2, 1]) {
      const layout = { mode, lines };
      const candidate = await fits({ ...record, layout });
      if (candidate) { record.layout = layout; chosen = candidate; break; }
    }
  }
  for (const tiles of [4096, 3072, 2304, 1728, 1296, 972, 729, 486, 324, 192, 96, 32]) {
    const aspect = width / height;
    const columns = Math.max(1, Math.min(255, Math.floor(Math.sqrt(tiles * aspect))));
    const rows = Math.max(1, Math.min(255, Math.floor(tiles / columns), Math.round(columns / aspect)));
    const visual = encodeVisualReference(image, columns, rows);
    const candidate = await fits({ ...record, visual });
    if (candidate) { chosen = candidate; break; }
  }
  if (!text && !chosen) throw new Error("Cannot fit a visual reference within this page's QR budget");
  return { ...page, image: undefined, body: chosen || baseBytes, pageEvidence: chosen };
}
