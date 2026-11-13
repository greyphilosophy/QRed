import { encodePageEvidence, encodeVisualReference } from "../pageEvidence.js";
import { encodedBodyCandidates, selectBodyEncoding } from "../sealCompression.js";
import { sealEnvelopeOverhead, utf8 } from "../sealFormat.js";
import { evidenceBodyBudget, MAX_PDF_SEALS, recordCapacity } from "../sealBudget.js";
export { evidenceBodyBudget } from "../sealBudget.js";

export async function encodedBodyLength(bytes, strategy = "automatic") {
  return selectBodyEncoding(await encodedBodyCandidates(bytes, strategy), strategy).payload_bytes;
}

export async function planPageEvidence(page, { attested = false, multiple = false, encodingStrategy = "automatic", maxPageSeals = MAX_PDF_SEALS } = {}) {
  const { text, width, height, lines, image, blank } = page;
  const baseBytes = utf8.encode(text);
  const baseLength = await encodedBodyLength(baseBytes, encodingStrategy);
  const minimumHeader = sealEnvelopeOverhead({ attested, multiple });
  if (baseLength + minimumHeader > recordCapacity(maxPageSeals, attested)) {
    throw new Error(`PDF page ${page.pageNumber || 1} exceeds the ${maxPageSeals}-QR limit. Choose seal sheets or split this page's content.`);
  }
  const budget = evidenceBodyBudget(baseLength, { attested, multiple, maxPageSeals });
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
  // Before spending the remainder on a thumbnail, bind observed readings
  // to exact line boxes. Respect the existing no-extra-QR evidence budget.
  if (record.layout?.mode === 3 && lines.length <= 512 && page.ocrReadings?.length) {
    let start = 1, end = Math.min(512, page.ocrReadings.length);
    while (start <= end) {
      const count = Math.floor((start + end) / 2), ocrReadings = page.ocrReadings.slice(0, count);
      const candidate = await fits({ ...record, ocrReadings });
      if (candidate) { record.ocrReadings = ocrReadings; chosen = candidate; start = count + 1; }
      else end = count - 1;
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
