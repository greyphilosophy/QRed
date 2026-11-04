import { pageHomography } from "../qr/pageAlignedScan.js";
import { boundedPhotoTokens, comparePhotoText, OCR_REVIEW_THRESHOLD } from "./photoTextComparison.js";

export function enclosingBox(boxes) {
  if (!boxes.length) return null;
  return { x0: Math.min(...boxes.map(b => b.x0)), y0: Math.min(...boxes.map(b => b.y0)),
    x1: Math.max(...boxes.map(b => b.x1)), y1: Math.max(...boxes.map(b => b.y1)) };
}

// Signed locations describe the ORIGINAL page. Coarse line starts and a
// different paper aspect (for example a Letter page extended with a Legal
// footer) are not enough to infer safe line boxes: keep sequence comparison.
export function signedPhotoLines(text, evidence, corners, dimensions, words = []) {
  const detected = locateSignedLines(text, evidence, corners, dimensions, words);
  if (detected || !corners) return detected;
  // Edge detection can find a watermark or inner frame instead of the page.
  // Retry the raster bounds only through the existing strict borderless path:
  // matching full-page aspect AND an independently calibrated global transform.
  // Never relax the detected geometry or accept unanchored image bounds.
  return locateSignedLines(text, evidence, null, dimensions, words);
}

function locateSignedLines(text, evidence, corners, { width, height }, words) {
  const lines = text.split("\n").filter(line => line.trim());
  // A PDF raster (or an edge-to-edge scan) has no surrounding paper border.
  // Its image bounds are only a candidate, never evidence by themselves:
  // require matching aspect and a single independently anchored print transform.
  const borderless = !corners;
  if (borderless) {
    if (![width, height, evidence?.width, evidence?.height].every(value => Number.isFinite(value) && value > 0)
      || Math.abs(Math.log((width / height) / (evidence.width / evidence.height))) > .02) return null;
    corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
  }
  if (evidence?.text !== text || evidence.layout?.mode !== 3 || lines.length > 512
      || words.length > 4000 || !Array.isArray(evidence.layout.lines) || evidence.layout.lines.length !== lines.length || corners?.length !== 4
      || corners.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)
        || p.x < 0 || p.y < 0 || p.x > width || p.y > height)) return null;
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const ratio = (distance(corners[0], corners[1]) + distance(corners[2], corners[3]))
    / (distance(corners[0], corners[3]) + distance(corners[1], corners[2]));
  if (!Number.isFinite(ratio) || Math.abs(Math.log(ratio / (evidence.width / evidence.height))) > .15) return null;
  const mapping = pageHomography(corners);
  if (!mapping) return null;
  if (evidence.layout.lines.some(box => !box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)
    || box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0 || box.height > .15
    || box.x + box.width > 1.001 || box.y + box.height > 1.001)) return null;
  const adjustment = words.length ? printAdjustment(lines, evidence.layout.lines, words, mapping) : null;
  if (borderless && !adjustment) return null;
  const project = (x, y) => adjustment ? mapping(x * adjustment.scale + adjustment.x, y * adjustment.scale + adjustment.y) : mapping(x, y);
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const box = evidence.layout.lines[i];
    const polygon = [[box.x, box.y], [box.x + box.width, box.y],
      [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]].map(([x, y]) => project(x, y));
    const bounds = enclosingBox(polygon.map(p => ({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })));
    result.push({ text: lines[i], polygon, bbox: bounds, wordIndices: [] });
  }
  // A page border alone cannot establish the position of printed content.
  // Without a calibrated print transform, require several independently read
  // lines to confirm the unadjusted geometry; otherwise keep the old comparison.
  if (words.length && !adjustment) {
    const anchors = assignPhotoLines(result, words).filter(line => compact(line.text)
      === compact(line.wordIndices.map(i => words[i].text).join(" ")));
    if (anchors.length < Math.min(lines.length, 2)) return null;
  }
  return result;
}

const compact = text => text.normalize("NFC").replace(/\s/gu, "");

function pagePoint(mapping, x, y) {
  let u = .5, v = .5;
  for (let i = 0; i < 6; i++) {
    const p = mapping(u, v), px = mapping(u + .001, v), py = mapping(u, v + .001);
    const a = (px.x - p.x) / .001, b = (py.x - p.x) / .001;
    const c = (px.y - p.y) / .001, d = (py.y - p.y) / .001, determinant = a * d - b * c;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-6) return null;
    u += (d * (x - p.x) - b * (y - p.y)) / determinant;
    v += (a * (y - p.y) - c * (x - p.x)) / determinant;
  }
  return Number.isFinite(u) && Number.isFinite(v) ? { x: u, y: v } : null;
}

// Printer fit-to-page scales/offsets the entire document inside the paper.
// Exact, distinctive OCR anchors estimate ONE bounded global transform. No
// individual row can move to whichever amount or wording happens to match.
function printAdjustment(textLines, boxes, words, mapping) {
  const grouped = new Map();
  for (const word of words) {
    if (word.lineId === undefined || !word.bbox) continue;
    if (!grouped.has(word.lineId)) grouped.set(word.lineId, []);
    grouped.get(word.lineId).push(word);
  }
  const keys = textLines.map(compact), anchors = [];
  for (let i = 0; i < keys.length && anchors.length < 48; i++) {
    const key = keys[i];
    if (key.length < 8 || key.length > 250 || !/[\p{L}]{3}/u.test(key) || keys.indexOf(key) !== keys.lastIndexOf(key)) continue;
    const matches = [];
    for (const group of grouped.values()) for (let first = 0; first < group.length; first++) {
      let observed = "";
      for (let last = first; last < Math.min(group.length, first + 32); last++) {
        observed += compact(group[last].text);
        if (!key.startsWith(observed)) break;
        // Confidence still controls the comparison verdict. For registration,
        // an exact, unique whole-line reading can locate faint text too.
        if (observed === key) { matches.push(enclosingBox(group.slice(first, last + 1).map(w => w.bbox))); break; }
      }
    }
    if (matches.length !== 1) continue;
    const observed = matches[0], expected = boxes[i];
    const point = pagePoint(mapping, (observed.x0 + observed.x1) / 2, (observed.y0 + observed.y1) / 2);
    if (point) anchors.push({ x: expected.x + expected.width / 2, y: expected.y + expected.height / 2, point });
  }
  let best = null;
  for (let i = 0; i < anchors.length; i++) for (let j = i + 1; j < anchors.length; j++) {
    const a = anchors[i], b = anchors[j];
    if (Math.abs(b.y - a.y) < .35) continue;
    const scale = (b.point.y - a.point.y) / (b.y - a.y);
    const x = ((a.point.x - scale * a.x) + (b.point.x - scale * b.x)) / 2;
    const y = a.point.y - scale * a.y;
    if (scale < .88 || scale > 1.04 || Math.abs(x) > .08 || Math.abs(y) > .08) continue;
    const inliers = anchors.filter(p => Math.abs(p.point.x - (p.x * scale + x)) < .012
      && Math.abs(p.point.y - (p.y * scale + y)) < .008);
    if (inliers.length < 3 || inliers.length < anchors.length * .65) continue;
    const error = inliers.reduce((sum, p) => sum + Math.abs(p.point.x - (p.x * scale + x)) + Math.abs(p.point.y - (p.y * scale + y)), 0);
    if (!best || inliers.length > best.count || (inliers.length === best.count && error < best.error))
      best = { scale, x, y, count: inliers.length, error };
  }
  return best;
}

function contains(polygon, x, y) {
  const sides = polygon.map((p, i) => {
    const next = polygon[(i + 1) % polygon.length];
    return (next.x - p.x) * (y - p.y) - (next.y - p.y) * (x - p.x);
  });
  return sides.every(n => n >= 0) || sides.every(n => n <= 0);
}

export function assignPhotoLines(lines, words) {
  const assigned = lines.map(line => ({ ...line, wordIndices: [] }));
  words.forEach((word, index) => {
    const box = word.bbox;
    if (!box) return;
    const x = (box.x0 + box.x1) / 2, y = (box.y0 + box.y1) / 2;
    const candidates = assigned.filter(line => contains(line.polygon, x, y));
    // Overlapping PDF line boxes must not reuse one photographed word twice.
    candidates.sort((a, b) => Math.abs(y - (a.bbox.y0 + a.bbox.y1) / 2)
      - Math.abs(y - (b.bbox.y0 + b.bbox.y1) / 2));
    candidates[0]?.wordIndices.push(index);
  });
  for (const line of assigned) line.wordIndices.sort((a, b) => words[a].bbox.x0 - words[b].bbox.x0);
  return assigned;
}

export function compareLocatedPhotoText(expected, words, dimensions, lines) {
  if (!lines) return comparePhotoText(expected, words, dimensions);
  // Keep the existing input/resource bounds even when comparison is partitioned.
  boundedPhotoTokens(expected, words);
  const assigned = assignPhotoLines(lines, words), used = new Set(), differences = [], classified = [];
  for (const line of assigned) {
    const indices = line.wordIndices;
    indices.forEach(index => used.add(index));
    const comparison = comparePhotoText(line.text, indices.map(index => words[index]), dimensions);
    classified.push(...comparison.words.map(word => ({ ...word, sourceIndex: indices[word.sourceIndex] })));
    differences.push(...comparison.differences.map(difference => ({ ...difference,
      wordIndices: difference.wordIndices.map(index => indices[index]),
      ...(!difference.wordIndices.length ? { boxes: [line.bbox] } : {}),
    })));
  }
  // An expected-region crop is never permission to ignore added text elsewhere.
  const outside = new Map();
  words.forEach((word, index) => {
    if (used.has(index) || !String(word.text || "").trim()) return;
    const key = word.lineId ?? `word-${index}`;
    if (!outside.has(key)) outside.set(key, []);
    outside.get(key).push(index);
  });
  for (const indices of outside.values()) {
    for (const sourceIndex of indices) {
      const word = words[sourceIndex], box = word.bbox;
      const valid = box && Object.values(box).every(Number.isFinite)
        && box.x0 >= 0 && box.y0 >= 0 && box.x1 <= dimensions.width
        && box.y1 <= dimensions.height && box.x1 > box.x0 && box.y1 > box.y0;
      classified.push({ ...word, sourceIndex, agrees: false, bbox: valid ? box : null,
        status: valid && Number.isFinite(word.confidence) && word.confidence >= OCR_REVIEW_THRESHOLD ? "different" : "uncertain" });
    }
    differences.push({ expected: "", observed: indices.map(index => words[index].text).join(" "), wordIndices: indices, context: "" });
  }
  classified.sort((a, b) => a.sourceIndex - b.sourceIndex);
  const uncertainCount = classified.filter(word => word.status === "uncertain").length;
  return { words: classified, differences, uncertainCount, lineAware: true,
    matchedCount: classified.filter(word => word.status === "matched").length,
    differentCount: classified.filter(word => word.status === "different").length,
    status: !classified.length ? "unreadable" : differences.some(d => !d.typography && !d.spacing)
      ? "differences" : uncertainCount ? "uncertain" : "matches" };
}
