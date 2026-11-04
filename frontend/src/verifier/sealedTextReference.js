// Comparison-only projection. Never rewrite authenticated PDF text or OCR
// evidence: callers retain the original record for source inspection.
export function sealedTextReference(text = "", evidence) {
  const ocr = evidence?.ocr;
  if (!ocr) return { text, evidence, hasOcr: false, conflicts: [], reviews: [], lines: [], unresolved: false };
  const native = text.split("\n").filter(line => line.trim()).map((text, index) => ({
    text, source: "native", box: evidence.layout?.mode === 3 ? evidence.layout.lines[index] : null,
  }));
  const conflicts = [], reviews = [], retained = [...native];
  // Native text remains the required comparison target. OCR can add a target
  // only when its whole line is independently located outside native regions.
  // Line-level boxes cannot safely split an OCR row into covered/new words.
  const bounded = native.length <= 512 && ocr.lines.length <= 512;
  const nativeLocated = native.every(line => validBox(line.box));
  let unresolved = !bounded || !nativeLocated;
  for (const line of ocr.lines) {
    const entry = { text: line.text, source: "ocr", confidence: line.confidence, box: line };
    if (native.length && (!bounded || !nativeLocated || !validBox(line))) {
      reviews.push({ ocr: line.text, confidence: line.confidence, reason: "Location could not be reconciled with PDF text" });
      unresolved = true;
      continue;
    }
    const nearby = native.filter(item => overlapArea(item.box, line) > 0);
    if (nearby.length) {
      // Suppress only a one-to-one exact reading with substantial coverage of
      // BOTH boxes. Containment alone may be a combined row or partial line.
      if (nearby.length === 1 && nearby[0].text === line.text && sameRegion(nearby[0].box, line)) continue;
      const conflict = { native: nearby.map(item => item.text), ocr: line.text, confidence: line.confidence };
      conflicts.push(conflict);
      reviews.push({ ...conflict, reason: "Overlapping source readings require review" });
      unresolved = true;
      continue;
    }
    if (!validBox(line)) unresolved = true;
    retained.push(entry);
  }
  const located = retained.every(line => validBox(line.box));
  // With no supplemental OCR target, preserve the native sequence exactly.
  if (located && retained.length > native.length) retained.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const comparisonText = retained.map(line => line.text).join("\n");
  return { text: comparisonText, evidence: { ...evidence, text: comparisonText,
    layout: located && retained.length ? { mode: 3, lines: retained.map(line => line.box) } : null },
  hasOcr: true, conflicts, reviews, lines: retained, unresolved };
}

function validBox(box) {
  return box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
    && box.width > 0 && box.height > 0;
}
function overlapArea(a, b) {
  if (!validBox(a) || !validBox(b)) return 0;
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}
function sameRegion(a, b) {
  const area = overlapArea(a, b);
  return area >= a.width * a.height * .5 && area >= b.width * b.height * .5;
}
