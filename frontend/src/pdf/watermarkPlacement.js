import { pageWatermarkRegions } from "../qr/pageAlignedScan.js";

// Predict watermark obstruction from the ORIGINAL page. Layout selection only
// queries these maps: it does not stamp, render, or decode trial watermarks.
const MAX_ANALYSIS_EDGE = 384;
const MARGIN = 18;
const GAP = 12;
const ENTRY_GAP = 8;
export const MIN_WATERMARK_MODULE_SIZE = 1.5;

function integral(values, width, height) {
  const stride = width + 1, table = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += values[y * width + x];
      table[(y + 1) * stride + x + 1] = table[y * stride + x + 1] + row;
    }
  }
  return table;
}

export function analyzeWatermarkPage(image) {
  const { width, height, data } = image;
  const cell = Math.max(1, Math.ceil(Math.max(width, height) / MAX_ANALYSIS_EDGE));
  const columns = Math.ceil(width / cell), rows = Math.ceil(height / cell);
  const dark = new Float64Array(columns * rows), gray = new Float64Array(dark.length);
  const histogram = new Uint32Array(256), luminances = new Uint8Array(width * height);
  for (let i = 0; i < luminances.length; i++) {
    const value = Math.round((data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3);
    luminances[i] = value;
    histogram[value]++;
  }
  let white = 255, count = 0;
  while (white > 1 && count < width * height * 0.02) count += histogram[white--];
  white++;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = luminances[y * width + x];
    const index = Math.floor(y / cell) * columns + Math.floor(x / cell);
    if (value < white * 0.7) dark[index]++;
    else if (value < white * 0.965) {
      // Do not mistake the antialiased fringe of black text for gray graphics.
      // Include a small uncertainty margin around the scanner's text mask.
      let fringe = false;
      for (let dy = -2; dy <= 2 && !fringe; dy++) for (let dx = -2; dx <= 2; dx++) {
        const sx = x + dx, sy = y + dy;
        if (sx >= 0 && sx < width && sy >= 0 && sy < height && luminances[sy * width + sx] < white * 0.3) {
          fringe = true; break;
        }
      }
      if (fringe) dark[index]++; else gray[index]++;
    }
  }
  const ink = new Float64Array(dark.length);
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const index = y * columns + x;
    const pixels = Math.min(cell, width - x * cell) * Math.min(cell, height - y * cell);
    dark[index] /= pixels; gray[index] /= pixels;
    ink[index] = dark[index] + gray[index];
  }
  const density = integral(dark, columns, rows), stride = columns + 1;
  const broad = new Float64Array(dark.length);
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    const left = Math.max(0, x - 1), right = Math.min(columns, x + 2);
    const top = Math.max(0, y - 1), bottom = Math.min(rows, y + 2);
    const coverage = (density[bottom * stride + right] - density[top * stride + right]
      - density[bottom * stride + left] + density[top * stride + left]) / ((right - left) * (bottom - top));
    // A narrow black stroke has white neighbors from which the scanner can
    // reconstruct pale ink. Broad black regions have no such evidence. Gray
    // graphics can themselves be mistaken for the pale QR modules.
    broad[y * columns + x] = Math.max(0, (coverage - 0.6) / 0.4) ** 2;
  }
  const risk = new Float64Array(dark.length);
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) {
    let obstruction = 0;
    // Restore the edge of broad graphics after the density measurement. Thin
    // text has no broad core, so this does not turn every glyph into a keepout.
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const sx = x + dx, sy = y + dy;
      if (sx >= 0 && sx < columns && sy >= 0 && sy < rows) obstruction = Math.max(obstruction, broad[sy * columns + sx]);
    }
    risk[y * columns + x] = Math.min(1, obstruction + gray[y * columns + x]);
  }
  return { columns, rows, cell, scale: image.scale, bounds: image.bounds,
    risk: integral(risk, columns, rows), ink: integral(ink, columns, rows) };
}

// Fractional integral lookup avoids snapping narrow timing strips to a whole
// analysis cell. Values within a cell are treated as uniformly distributed.
function at(table, map, x, y) {
  x = Math.max(0, Math.min(map.columns, x)); y = Math.max(0, Math.min(map.rows, y));
  const left = Math.min(map.columns - 1, Math.floor(x)), top = Math.min(map.rows - 1, Math.floor(y));
  const fx = x - left, fy = y - top, stride = map.columns + 1;
  const a = table[top * stride + left], b = table[top * stride + left + 1];
  const c = table[(top + 1) * stride + left], d = table[(top + 1) * stride + left + 1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

function mean(table, map, x, y, width, height) {
  const scale = map.scale / map.cell;
  const left = (x - map.bounds.x) * scale, right = left + width * scale;
  const top = (map.bounds.y + map.bounds.height - y - height) * scale, bottom = top + height * scale;
  return Math.max(0, (at(table, map, right, bottom) - at(table, map, left, bottom)
    - at(table, map, right, top) + at(table, map, left, top)) / ((right - left) * (bottom - top)));
}

function symbolCost(map, box, moduleCount) {
  const unit = box.width / (moduleCount + 8);
  const region = (column, row, width, height, table = map.risk) => mean(table, map,
    box.x + column * unit, box.y + box.height - (row + height) * unit, width * unit, height * unit);
  const body = region(4, 4, moduleCount, moduleCount);
  // Protect finder patterns, separators and their adjacent format bits. An
  // obstructed locator cannot be rescued by ordinary payload error correction.
  const finderRegions = [[3, 3, 10, 10], [moduleCount - 7, 3, 12, 10], [3, moduleCount - 7, 10, 12]];
  const finders = Math.max(...finderRegions.map(([x, y, w, h]) => region(x, y, w, h)));
  // Thin printed text was previously ignored by the broad-graphic risk map.
  // Do not place a finder over enough original ink to make alignment unreliable.
  const finderInk = Math.max(...finderRegions.map(([x, y, w, h]) => region(x, y, w, h, map.ink)));
  if (finderInk > 0.08) return Infinity;
  const timing = Math.max(region(12, 10, moduleCount - 16, 1), region(10, 12, 1, moduleCount - 16));
  const alignment = moduleCount > 21 ? region(moduleCount - 6, moduleCount - 6, 7, 7) : 0;
  const quiet = Math.max(region(0, 0, moduleCount + 8, 4), region(0, moduleCount + 4, moduleCount + 8, 4),
    region(0, 4, 4, moduleCount), region(moduleCount + 4, 4, 4, moduleCount));
  const ink = region(0, 0, moduleCount + 8, moduleCount + 8, map.ink);
  // These are ranking weights, not probabilities or error-correction budgets.
  // The size term favors larger printed modules when obstruction is similar.
  return 8 * body + 8 * finders + 18 * finderInk + 2 * timing + 2 * alignment + 2 * quiet + 0.03 * ink
    + 0.35 * (MIN_WATERMARK_MODULE_SIZE / unit) ** 2;
}

function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function axis(start, end, step) {
  const values = [start];
  for (let value = start + step; value < end - 0.01; value += step) values.push(value);
  if (end > start + 0.01) values.push(end);
  return values;
}

// Standardized page-filling geometry is recoverable from a photograph without
// knowing the sealer's placement decisions. The old content-avoiding planner
// remains a fallback for graphics and failed print/photo preflight.
export function planWatermarks(image, symbols, entry = null, { excludeBoxes = null, preferPageAligned = true } = {}) {
  const map = analyzeWatermarkPage(image), { bounds } = image;
  if (preferPageAligned && !entry && !excludeBoxes &&
      (symbols.length === 1 || symbols.length === 4)) {
    const regions = pageWatermarkRegions(symbols.length);
    const boxes = regions.map(region => ({
      x: bounds.x + region.x * bounds.width,
      y: bounds.y + (1 - region.y - region.height) * bounds.height,
      width: region.width * bounds.width,
      height: region.height * bounds.height,
    }));
    const legibleModules = boxes.every((box, i) =>
      Math.min(box.width, box.height) / symbols[i].modules.size >= MIN_WATERMARK_MODULE_SIZE);
    const broadInterference = boxes.some(box => mean(map.risk, map, box.x, box.y, box.width, box.height) > 0.012);
    if (legibleModules && !broadInterference) return boxes;
  }
  const area = { x: bounds.x + MARGIN, y: bounds.y + MARGIN,
    width: bounds.width - 2 * MARGIN, height: bounds.height - 2 * MARGIN };
  const keepout = entry && { x: entry.x - ENTRY_GAP, y: entry.y - ENTRY_GAP,
    width: entry.width + 2 * ENTRY_GAP, height: entry.height + 2 * ENTRY_GAP };
  const minimum = Math.max(...symbols.map(symbol => (symbol.modules.size + 8) * MIN_WATERMARK_MODULE_SIZE));
  // Optimize the obstruction field at bounded spatial resolution, then refine
  // its minimum. No guessed layout is ever drawn or sent to the QR decoder.
  const step = Math.max(4, Math.max(bounds.width, bounds.height) / 160);
  let best = null;
  const consider = (x, y, size, columns, rows) => {
    if (size < minimum - 0.001 || x < area.x - 0.001 || y < area.y - 0.001
      || x + columns * size + (columns - 1) * GAP > area.x + area.width + 0.001
      || y + rows * size + (rows - 1) * GAP > area.y + area.height + 0.001) return;
    const boxes = symbols.map((_, index) => ({ x: x + (index % columns) * (size + GAP),
      y: y + (rows - 1 - Math.floor(index / columns)) * (size + GAP), width: size, height: size }));
    if (keepout && boxes.some(box => overlaps(box, keepout))) return;
    // A failed first attempt should not retry nearly identical geometry.
    // Reject candidates overlapping >70% of each previous symbol's footprint.
    if (excludeBoxes?.length === boxes.length && boxes.every((box, index) => {
      const prior = excludeBoxes[index];
      const overlapWidth = Math.max(0, Math.min(box.x + box.width, prior.x + prior.width) - Math.max(box.x, prior.x));
      const overlapHeight = Math.max(0, Math.min(box.y + box.height, prior.y + prior.height) - Math.max(box.y, prior.y));
      return overlapWidth * overlapHeight / Math.min(box.width * box.height, prior.width * prior.height) > 0.7;
    })) return;
    const scores = boxes.map((box, index) => symbolCost(map, box, symbols[index].modules.size));
    if (scores.some(score => !Number.isFinite(score))) return;
    // Do not trade one unreadable part for a very clean neighboring part.
    const score = Math.max(...scores) + scores.reduce((sum, value) => sum + value, 0) / scores.length * 0.1;
    if (!best || score < best.score - 1e-9 || (Math.abs(score - best.score) < 1e-9 && size > best.size)) {
      best = { boxes, score, x, y, size, columns, rows };
    }
  };
  for (let columns = 1; columns <= symbols.length; columns++) {
    const rows = Math.ceil(symbols.length / columns);
    const maximum = Math.min((area.width - GAP * (columns - 1)) / columns, (area.height - GAP * (rows - 1)) / rows);
    if (maximum < minimum) continue;
    for (const size of axis(minimum, maximum, step * 2).reverse()) {
      const right = area.x + area.width - columns * size - (columns - 1) * GAP;
      const top = area.y + area.height - rows * size - (rows - 1) * GAP;
      for (const y of axis(area.y, top, step)) for (const x of axis(area.x, right, step)) consider(x, y, size, columns, rows);
    }
  }
  if (!best) throw new Error("This page's seal data is too dense for readable experimental watermarks. Choose a footer layout.");
  const coarse = best;
  for (const size of axis(Math.max(minimum, coarse.size - step * 2), coarse.size + step * 2, step / 2)) {
    for (const y of axis(coarse.y - step, coarse.y + step, step / 2)) {
      for (const x of axis(coarse.x - step, coarse.x + step, step / 2)) consider(x, y, size, coarse.columns, coarse.rows);
    }
  }
  return best.boxes;
}
