import { encodePageEvidence, encodeVisualReference } from "../pageEvidence.js";
import { encodedBodyCandidates, selectBodyEncoding } from "../sealCompression.js";
import { MAX_CHUNKS, sealEnvelopeOverhead, utf8 } from "../sealFormat.js";
import { evidenceBodyBudget, MAX_PDF_SEALS, recordCapacity } from "../sealBudget.js";
export { evidenceBodyBudget } from "../sealBudget.js";

export async function encodedBodyLength(bytes, strategy = "automatic") {
  return selectBodyEncoding(await encodedBodyCandidates(bytes, strategy), strategy).payload_bytes;
}

export async function planPageEvidence(page, { attested = false, multiple = false, encodingStrategy = "automatic", maxPageSeals = MAX_PDF_SEALS } = {}) {
  const { text, width, height, lines, image, blank, ocrReadings } = page;
  const record = { text, width, height, blank };
  if (blank) {
    const body = encodePageEvidence(record);
    return { ...page, image: undefined, body, pageEvidence: body };
  }

  // An exact source reading is usable only with its signed line box. Size
  // this complete record before deciding how many QR pieces the page needs.
  if (ocrReadings?.length) {
    record.layout = { mode: 3, lines };
    record.ocrReadings = ocrReadings;
  }
  let chosen = record.layout ? encodePageEvidence(record) : null;
  const requiredBody = chosen ?? utf8.encode(text);
  const baseLength = await encodedBodyLength(requiredBody, encodingStrategy);
  const minimumHeader = sealEnvelopeOverhead({ attested, multiple });
  if (baseLength + minimumHeader > recordCapacity(maxPageSeals, attested)) {
    const remedy = maxPageSeals < MAX_CHUNKS ? "Choose a layout with appended seal sheets." : "Split this page's content.";
    throw new Error(`PDF page ${page.pageNumber || 1} exceeds the ${maxPageSeals}-QR limit. ${remedy}`);
  }
  // Zero means an unknown signer identity could cross a size boundary.
  // It restricts optional additions and never removes required bytes.
  const budget = evidenceBodyBudget(baseLength, { attested, multiple, maxPageSeals });
  if (text && !budget) return { ...page, image: undefined, body: requiredBody, pageEvidence: chosen };
  const fits = async evidence => {
    const bytes = encodePageEvidence(evidence);
    return await encodedBodyLength(bytes, encodingStrategy) <= budget ? bytes : null;
  };
  if (!chosen && text && lines.length && lines.length <= 65535) {
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
  return { ...page, image: undefined, body: chosen ?? requiredBody, pageEvidence: chosen };
}
