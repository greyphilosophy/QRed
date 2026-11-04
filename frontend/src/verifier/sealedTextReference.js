// Comparison-only projection. Never rewrite authenticated PDF text or OCR
// evidence: callers retain the original record for source inspection.
export function sealedTextReference(text = "", evidence) {
  const ocr = evidence?.ocr;
  if (!ocr) return { text, evidence, hasOcr: false, conflicts: [], lines: [], unresolved: false };
  const native = text.split("\n").filter(line => line.trim()).map((text, index) => ({
    text, source: "native", box: evidence.layout?.mode === 3 ? evidence.layout.lines[index] : null,
  }));
  const conflicts = [], retained = [...native];
  // Bound reconciliation work on unusually large signed records. Without full
  // geometry or within-budget analysis we retain both sources, never dedup by
  // wording alone or guess that the PDF text covers a scanned region.
  const bounded = native.length <= 512 && ocr.lines.length <= 512;
  let unresolved = !bounded || native.some(line => !validBox(line.box));
  for (const line of ocr.lines) {
    const entry = { text: line.text, source: "ocr", confidence: line.confidence, box: line };
    const nearby = bounded && validBox(line) ? native.filter(item => overlaps(item.box, line)) : [];
    const different = nearby.filter(item => item.text !== line.text);
    if (different.length) conflicts.push({ native: different.map(item => item.text), ocr: line.text, confidence: line.confidence });
    // An identical neighbor does not suppress conflicting OCR evidence.
    if (!different.length && nearby.some(item => item.text === line.text)) continue;
    if (!validBox(line)) unresolved = true;
    retained.push(entry);
  }
  const located = retained.every(line => validBox(line.box));
  if (located) retained.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const comparisonText = retained.map(line => line.text).join("\n");
  return { text: comparisonText, evidence: { ...evidence, text: comparisonText,
    layout: located && retained.length ? { mode: 3, lines: retained.map(line => line.box) } : null },
  hasOcr: true, conflicts, lines: retained, unresolved };
}

function validBox(box) {
  return box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
    && box.width > 0 && box.height > 0;
}
function overlaps(a, b) {
  if (!validBox(a) || !validBox(b)) return false;
  const area = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  // Mere edge contact is not evidence that two readings describe one line.
  return area / Math.min(a.width * a.height, b.width * b.height) >= .5;
}
