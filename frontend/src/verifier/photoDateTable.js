import { isDateReading } from "./photoDateField.js";
import { OCR_REVIEW_THRESHOLD } from "./photoTextComparison.js";
import { assignPhotoLines } from "./photoTextLayout.js";

const firstToken = row => row.text.trim().split(/\s/u, 1)[0];
const centerY = box => (box.y0 + box.y1) / 2;
const rowHeight = row => row.polygon[3].y - row.polygon[0].y;

// A dated column needs multiple consecutive signed rows and two dates actually
// located by the first reading. Never give the OCR engine the signed values.
export function planDateTableRetry(words, lines, dimensions) {
  if (!lines?.some((line, i) => i >= 2 && isDateReading(firstToken(line)) &&
    isDateReading(firstToken(lines[i - 1])) && isDateReading(firstToken(lines[i - 2])))) return null;
  const rows = assignPhotoLines(lines, words);
  for (let start = 0; start < rows.length; start++) {
    const first = rows[start], left = first.polygon[0].x, height = rowHeight(first);
    if (height <= 0 || !isDateReading(firstToken(first))) continue;
    const fields = [], anchors = [];
    let i = start;
    for (; i < rows.length && fields.length < 64; i++) {
      const row = rows[i], expected = firstToken(row);
      const previous = rows[i - 1];
      if (!isDateReading(expected) || Math.abs(row.polygon[0].x - left) > height ||
          (i > start && (row.polygon[0].y <= previous.polygon[0].y ||
            row.polygon[0].y - previous.polygon[3].y > height * 2))) break;
      const anchor = row.wordIndices.map(index => words[index]).find(word =>
        isDateReading(word.text) && Math.abs(word.bbox.x0 - row.polygon[0].x) < height);
      if (anchor) anchors.push(anchor.bbox);
      fields.push({ row, expected, confirmed: anchor?.text === expected });
    }
    const heading = rows[start - 1];
    start = i - 1;
    if (fields.length < 3 || anchors.length < 2) continue;
    if (heading && /^date$/iu.test(firstToken(heading)) && Math.abs(heading.polygon[0].x - left) <= height &&
        first.polygon[0].y > heading.polygon[0].y && first.polygon[0].y - heading.polygon[3].y <= height * 2) {
      const expected = firstToken(heading);
      const confirmed = heading.wordIndices.some(index => words[index].text === expected &&
        Math.abs(words[index].bbox.x0 - left) < height);
      fields.unshift({ row: heading, expected, heading: true, confirmed });
    }
    if (fields.every(field => field.confirmed)) continue;
    // Allow for skew and the heading's inset. Keep the nearby description
    // column out of the segmentation area.
    const widths = anchors.map(box => box.x1 - box.x0).sort((a, b) => a - b);
    const width = widths[Math.floor(widths.length / 2)];
    const box = {
      x0: Math.max(0, Math.floor(Math.min(...anchors.map(box => box.x0)) - width / 2)),
      x1: Math.min(dimensions.width, Math.ceil(Math.max(...anchors.map(box => box.x1)) + width / 4)),
      y0: Math.max(0, Math.floor(fields[0].row.polygon[0].y - height * .75)),
      y1: Math.min(dimensions.height, Math.ceil(fields.at(-1).row.polygon[3].y + height * .75)),
    };
    if (box.x1 > box.x0 && box.y1 > box.y0) return { fields, box };
  }
  return null;
}

export function contrastCropCanvas(source, box, sx, sy, pixelLimit, gain = 1.8) {
  const width = box.x1 - box.x0, height = box.y1 - box.y0, pad = 14;
  if (!(width > 0 && height > 0 && pixelLimit > 0)) return null;
  const scale = Math.min(3, Math.max(sx, sy), Math.sqrt(pixelLimit / ((width + 2 * pad) * (height + 2 * pad))));
  if (scale < .8) return null;
  const w = Math.round(width * scale), h = Math.round(height * scale);
  if (!w || !h || (w + pad * 2) * (h + pad * 2) > pixelLimit) return null;
  const canvas = document.createElement("canvas");
  canvas.width = w + pad * 2; canvas.height = h + pad * 2;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, box.x0 * sx, box.y0 * sy, width * sx, height * sy, pad, pad, w, h);
  const image = ctx.getImageData(pad, pad, w, h), bytes = image.data;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < bytes.length; i += 4) {
    const value = Math.round((bytes[i] + bytes[i + 1] + bytes[i + 2]) / 3);
    bytes[i] = value;
    histogram[value]++;
  }
  // The dark tail samples ink and the median samples paper. Lift pale
  // overprint without using any expected text to tune the crop.
  let dark = 0, paper = 0, total = 0;
  for (let i = 0; i < histogram.length; i++) {
    total += histogram[i];
    if (total < w * h * .04) dark = i + 1;
    if (total >= w * h * .5) { paper = i; break; }
  }
  if (paper - dark < 8) { canvas.width = canvas.height = 0; return null; }
  const slope = 255 * gain / (paper - dark);
  for (let i = 0; i < bytes.length; i += 4) bytes[i] = bytes[i + 1] = bytes[i + 2] = (bytes[i] - dark) * slope;
  ctx.putImageData(image, pad, pad);
  return { canvas, project: boxInCrop => ({
    x0: box.x0 + (boxInCrop.x0 - pad) * width / w, x1: box.x0 + (boxInCrop.x1 - pad) * width / w,
    y0: box.y0 + (boxInCrop.y0 - pad) * height / h, y1: box.y0 + (boxInCrop.y1 - pad) * height / h,
  }) };
}

// Thin table rules above or below a heading can be segmented as one huge
// glyph. Remove only wide, thin horizontal bands outside the text's center.
export function prepareDateColumn(source, plan, sx, sy, pixelLimit) {
  const crop = contrastCropCanvas(source, plan.box, sx, sy, pixelLimit, 1);
  if (!crop || !plan.fields[0].heading) return crop;
  const { canvas, project } = crop;
  const bounds = project({ x0: 0, y0: 0, x1: canvas.width, y1: canvas.height });
  const scale = canvas.height / (bounds.y1 - bounds.y0);
  const heading = plan.fields[0].row, height = rowHeight(heading) * scale;
  const center = (heading.polygon[0].y - bounds.y0) * scale + height / 2;
  const bottom = (heading.polygon[3].y + plan.fields[1].row.polygon[0].y) / 2;
  const rows = Math.min(canvas.height, Math.max(1, Math.ceil((bottom - bounds.y0) * scale)));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, canvas.width, rows);
  const data = image.data;
  const rules = [];
  let start = -1;
  for (let y = 0; y <= rows; y++) {
    let ink = 0;
    if (y < rows) for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = data[i] * 1.8;
      if (data[i] < 180) ink++;
    }
    if (ink > canvas.width / 2 && Math.abs(y - center) > height * .4) {
      if (start < 0) start = y;
    } else if (start >= 0) {
      if (y - start <= height / 4) rules.push([start, y]);
      start = -1;
    }
  }
  ctx.putImageData(image, 0, 0);
  const margin = Math.max(1, Math.round(height * .06));
  ctx.fillStyle = "white";
  for (const [top, bottom] of rules) ctx.fillRect(0, top - margin, canvas.width, bottom - top + 2 * margin);
  return crop;
}

function containsReading(container, box, required = .65) {
  const overlap = Math.max(0, Math.min(box.x1, container.x1) - Math.max(box.x0, container.x0)) *
    Math.max(0, Math.min(box.y1, container.y1) - Math.max(box.y0, container.y0));
  return overlap >= required * (box.x1 - box.x0) * (box.y1 - box.y0);
}

// Sometimes the page splits a complete date into a digit and another
// date-shaped token. Accept the longer reading only when the shorter text
// occupies the corresponding part of the photographed word.
function locatedSubstring(first, word) {
  if (!first.text || first.text.length >= word.text.length) return false;
  const offset = word.text.indexOf(first.text);
  if (offset < 0) return false;
  const box = word.bbox, advance = (box.x1 - box.x0) / word.text.length;
  return Math.abs(first.bbox.x0 - box.x0 - offset * advance) < .65 * advance &&
    Math.abs(first.bbox.x1 - box.x0 - (offset + first.text.length) * advance) < .65 * advance;
}

export function applyDateColumn(words, plan, reread) {
  const replacements = new Map(), removed = new Set(), added = [], retryReviews = [];
  const groups = plan.fields.map(() => []), dateBoxes = [];
  for (const word of reread) {
    const box = word.bbox;
    let closest = -1, distance = Infinity;
    for (const [i, { row }] of plan.fields.entries()) {
      const top = row.polygon[0], height = rowHeight(row);
      const dy = Math.abs(centerY(box) - (top.y + height / 2));
      if (dy <= height * .85 && dy < distance && Math.abs(box.x0 - top.x) < height) {
        closest = i; distance = dy;
      }
    }
    if (closest !== -1) groups[closest].push(word);
  }
  for (const [i, { heading, expected }] of plan.fields.entries()) {
    const group = groups[i];
    const [word] = group;
    const complete = group.length === 1 && (heading ? /^\p{L}+$/u.test(word.text) : isDateReading(word.text));
    if (!complete) {
      for (const extra of group) {
        if (!(extra.confidence >= OCR_REVIEW_THRESHOLD) || extra.bbox.x0 < plan.box.x0 || extra.bbox.x1 > plan.box.x1) continue;
        // A confidently read addition that the page OCR missed is evidence too.
        const overlapsFirst = words.some(({ bbox: b }) => b && b.x0 < extra.bbox.x1 && b.x1 > extra.bbox.x0 &&
          b.y0 < extra.bbox.y1 && b.y1 > extra.bbox.y0);
        if (!overlapsFirst) added.push(extra);
      }
      continue;
    }
    if (!(word.confidence >= OCR_REVIEW_THRESHOLD)) continue;
    const box = word.bbox;
    // A clipped word may have been assigned to an adjacent signed row.
    // Determine what ink this reading covers using photographed coordinates.
    const indices = words.flatMap((first, index) => first.bbox &&
      first.bbox.x0 >= plan.box.x0 && first.bbox.x1 <= plan.box.x1 &&
      Math.abs(centerY(first.bbox) - centerY(box)) < (box.y1 - box.y0) &&
      containsReading(box, first.bbox) ? [index] : []);
    const joined = indices.map(index => words[index]).sort((a, b) => a.bbox.x0 - b.bbox.x0)
      .map(first => first.text).join("");
    const competing = indices.find(index => {
      const first = words[index];
      return first.text !== word.text && joined !== word.text && first.confidence >= OCR_REVIEW_THRESHOLD &&
        !locatedSubstring(first, word) && (isDateReading(first.text) || /^\p{L}{2,}$/u.test(first.text) || first.bbox.x1 - first.bbox.x0 >= .85 * (box.x1 - box.x0));
    });
    if (competing !== undefined) {
      retryReviews.push({ dateField: !heading, signedDate: expected, original: words[competing].text,
        observed: word.text, boxes: [box], lowConfidence: false });
      continue;
    }
    if (!heading) dateBoxes.push(box);
    if (indices.length) {
      const first = words[indices[0]];
      // Keep a whole-page location and line identity when both passes agree.
      // Dropping those anchors changes registration for unrelated rows.
      replacements.set(indices[0], indices.length === 1 && first.text === word.text
        ? { ...first, confidence: Math.max(first.confidence, word.confidence) } : word);
      indices.forEach(index => removed.add(index));
    } else added.push(word);
  }
  // Page segmentation sometimes groups aligned digits down the column.
  // Every glyph in that weak vertical word must belong to confident dates
  // on at least two different rows. Keep any ink in the gaps for review.
  for (const [index, first] of words.entries()) {
    if (!first.verticalGlyphs || first.confidence >= OCR_REVIEW_THRESHOLD) continue;
    const covered = first.verticalGlyphs.map(glyph => dateBoxes.find(box => containsReading(box, glyph, .9)));
    if (covered.every(Boolean) && new Set(covered).size >= 2) removed.add(index);
  }
  return { words: [...words.flatMap((word, i) => replacements.get(i) || (removed.has(i) ? [] : [word])), ...added], retryReviews };
}
