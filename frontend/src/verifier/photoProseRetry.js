import { enclosingBox } from "./photoTextLayout.js";
import { OCR_REVIEW_THRESHOLD } from "./photoTextComparison.js";

const centerX = b => (b.x0 + b.x1) / 2;
const centerY = b => (b.y0 + b.y1) / 2;
const prose = text => (text?.match(/\p{L}{2,}/gu) || []).length >= 4;

// A tall, weak word between two lines can contain ink from both of them.
// Anchor the read to photographed words on each line and replace only the
// disputed span. Wider page text supplies recognition context around it.
export function planProseRetry(words, groups, questioned, { width, height }) {
  // A joined box's center can fall into the gap between the signed rows.
  // Keep its engine line when neighboring words place that line on the page.
  const assigned = new Set(groups.flatMap(row => row.wordIndices));
  const outside = new Map();
  words.forEach((word, i) => {
    if (assigned.has(i) || !word.bbox || word.lineId == null || !questioned.has(i)) return;
    if (!outside.has(word.lineId)) outside.set(word.lineId, []);
    outside.get(word.lineId).push(i);
  });
  const proseRows = groups.map(row => {
    if (!prose(row.text)) return null;
    const ids = new Set(row.wordIndices.map(i => words[i].lineId));
    const extra = [...ids].flatMap(id => outside.get(id) || []).filter(i => {
      const b = words[i].bbox, a = row.bbox;
      return a.x0 < centerX(b) && centerX(b) < a.x1 && b.y0 < a.y1 && a.y0 < b.y1;
    });
    return [...row.wordIndices, ...extra];
  });
  for (let i = 1; i < groups.length; i++) {
    const pair = [proseRows[i - 1], proseRows[i]];
    if (!pair.every(Boolean)) continue;
    const nearby = [...new Set(pair.flat())];
    const bad = nearby.filter(j => questioned.has(j) && words[j].confidence < OCR_REVIEW_THRESHOLD);
    const trusted = pair.map(row => row.filter(j => !questioned.has(j) && words[j].confidence >= OCR_REVIEW_THRESHOLD));
    for (const seed of bad) {
      const b = words[seed].bbox, h = b.y1 - b.y0;
      if (!(h > 0 && h < height * .05)) continue;
      const spansBoth = trusted.every(row => row.some(j => {
        const a = words[j].bbox;
        return h > (a.y1 - a.y0) * 1.6 && b.y0 < centerY(a) && centerY(a) < b.y1 &&
          a.x1 > b.x0 - 3 * h && a.x0 < b.x1 + 3 * h;
      }));
      if (!spansBoth) continue;
      const targets = bad.filter(j => words[j].bbox.x0 < b.x1 + 1.5 * h && words[j].bbox.x1 > b.x0 - 1.5 * h);
      if (!pair.every(row => targets.some(j => row.includes(j)))) continue;
      const area = enclosingBox(targets.map(j => words[j].bbox));
      const left = area.x0 - .4 * h, right = area.x1 + .4 * h;
      const rows = pair.map((row, k) => {
        const indices = row.filter(j => left <= centerX(words[j].bbox) && centerX(words[j].bbox) <= right);
        return { indices, anchors: trusted[k].filter(j => indices.includes(j)),
          left: Math.max(left, ...row.filter(j => centerX(words[j].bbox) < left).map(j => words[j].bbox.x1)),
          right: Math.min(right, ...row.filter(j => centerX(words[j].bbox) > right).map(j => words[j].bbox.x0)) };
      });
      if (rows.some(row => !row.anchors.length)) continue;
      const bbox = { x0: Math.max(0, Math.floor(left - .25 * h)), x1: Math.min(width, Math.ceil(right + 3 * h)),
        y0: Math.max(0, Math.floor(area.y0 - .55 * h)), y1: Math.min(height, Math.ceil(area.y1 + .3 * h)) };
      return { prose: rows, priority: -1, bbox, indices: [...new Set(rows.flatMap(row => row.indices))] };
    }
  }
  return null;
}

export function selectProseReading(words, candidate, read) {
  const kept = [];
  const used = new Set();
  for (const row of candidate.prose) {
    const anchors = row.anchors.map(j => words[j]);
    const anchor = read.find(w => w.lineId != null && w.confidence >= OCR_REVIEW_THRESHOLD && anchors.some(first => {
      const a = first.bbox, b = w.bbox;
      return w.text === first.text && a.x0 <= centerX(b) && centerX(b) <= a.x1 &&
        a.y0 <= centerY(b) && centerY(b) <= a.y1;
    }));
    if (!anchor || used.has(anchor.lineId)) return null;
    used.add(anchor.lineId);
    const observed = read.filter(w => w.lineId === anchor.lineId && row.left <= centerX(w.bbox) && centerX(w.bbox) <= row.right);
    kept.push(...observed);
  }
  // A third line of ink in the disputed span needs its own review.
  const left = Math.min(...candidate.prose.map(row => row.left)), right = Math.max(...candidate.prose.map(row => row.right));
  if (read.some(w => !used.has(w.lineId) && left <= centerX(w.bbox) && centerX(w.bbox) <= right)) return null;
  return kept;
}
