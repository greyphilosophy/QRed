import { encodePageEvidence, encodeVisualReference } from "../pageEvidence.js";
import { encodedBodyCandidates, selectBodyEncoding } from "../sealCompression.js";
import { sealEnvelopeOverhead, utf8 } from "../sealFormat.js";
import { evidenceBodyBudget, MAX_PDF_SEALS, recordCapacity } from "../sealBudget.js";
export { evidenceBodyBudget } from "../sealBudget.js";

export async function encodedBodyLength(bytes, strategy = "automatic") {
  return selectBodyEncoding(await encodedBodyCandidates(bytes, strategy), strategy).payload_bytes;
}

export async function planPageEvidence(page, { attested = false, multiple = false, encodingStrategy = "automatic" } = {}) {
  const { text, width, height, lines = [], image, blank, ocr = null } = page;
  const record = { text, width, height, blank, ocr };
  // An OCR pass can legitimately find no text on a nonblank image page.
  // Keep a minimal visual reference in its essential record in that case.
  if (ocr && !blank && !text?.trim() && !ocr.lines?.length && image) {
    record.visual = encodeVisualReference(image, 1, 1);
  }
  // OCR is signed essential evidence, never a best-effort thumbnail.
  const baseBytes = ocr ? encodePageEvidence(record) : utf8.encode(text);
  const baseLength = await encodedBodyLength(baseBytes, encodingStrategy);
  const minimumHeader = sealEnvelopeOverhead({ attested, multiple });
  if (baseLength + minimumHeader > recordCapacity(MAX_PDF_SEALS, attested)) {
    throw new Error(`PDF page ${page.pageNumber || 1} exceeds the ${MAX_PDF_SEALS}-QR limit. Shorten the page or split its content across pages.`);
  }
  const budget = evidenceBodyBudget(baseLength, { attested, multiple });
  if ((text || ocr) && !budget) return { ...page, image: undefined, body: baseBytes, pageEvidence: ocr ? baseBytes : null };
  const fits = async evidence => {
    const bytes = encodePageEvidence(evidence);
    return await encodedBodyLength(bytes, encodingStrategy) <= budget ? bytes : null;
  };
  if (blank) {
    const body = encodePageEvidence(record);
    return { ...page, image: undefined, body, pageEvidence: body };
  }
  let chosen = ocr ? baseBytes : null;
  if (text && lines.length && lines.length <= 65535) {
    // Spend on useful text coordinates first: boxes, byte coordinates, then
    // one-byte 16x16 line-start cells. Omit them altogether if nothing fits.
    for (const mode of [3, 2, 1]) {
      const layout = { mode, lines };
      const candidate = await fits({ ...record, layout });
      if (candidate) { record.layout = layout; chosen = candidate; break; }
    }
  }
  for (const tiles of image ? [4096, 3072, 2304, 1728, 1296, 972, 729, 486, 324, 192, 96, 32] : []) {
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
