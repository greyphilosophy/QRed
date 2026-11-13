// Re-measure a bowed QR on an evenly sampled module grid. Only public
// alignment and finder patterns supply coordinates. A text-covered marker
// can be skipped without moving the surrounding measurements.
import { alignmentCenters } from "./qrLowLevel.js";
import { bentModuleGrid } from "./bentModuleGrid.js";

export const SAMPLES = 8;

export function smoothGrid(values, width, sigma, radius = Math.ceil(3 * sigma)) {
  const weights = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-.5 * ((i - radius) / sigma) ** 2));
  const total = weights.reduce((a, b) => a + b);
  const height = values.length / width, horizontal = new Float32Array(values.length), out = new Float32Array(values.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++)
      sum += weights[k + radius] * values[y * width + Math.max(0, Math.min(width - 1, x + k))];
    horizontal[y * width + x] = sum / total;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++)
      sum += weights[k + radius] * horizontal[Math.max(0, Math.min(height - 1, y + k)) * width + x];
    out[y * width + x] = sum / total;
  }
  return out;
}

export function sampleGrid(image, map, size, shouldContinue) {
  const width = size * SAMPLES, values = new Float32Array(width * width);
  const { data } = image;
  const gray = i => (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) / 256;
  for (let y = 0; y < width; y++) {
    if (!shouldContinue()) return null;
    for (let x = 0; x < width; x++) {
      const p = map((x + .5) / SAMPLES, (y + .5) / SAMPLES);
      const xx = Math.floor(p.x), yy = Math.floor(p.y), a = p.x - xx, b = p.y - yy;
      if (xx < 0 || yy < 0 || xx + 1 >= image.width || yy + 1 >= image.height) continue;
      const i = (yy * image.width + xx) * 4, j = i + 4 * image.width;
      values[y * width + x] = (1 - b) * ((1 - a) * gray(i) + a * gray(i + 4)) +
        b * ((1 - a) * gray(j) + a * gray(j + 4));
    }
  }
  return smoothGrid(values, width, .65, 2);
}

function locateMark(pixels, width, col, row, radius) {
  let best = { score: -1 };
  const exposure = new Float32Array((2 * radius + 1) ** 2);
  const pattern = [], values = new Float32Array((2 * radius + 1) ** 2);
  for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
    const ring = Math.max(Math.abs(x), Math.abs(y));
    pattern.push({ x, y, sign: ring === radius || ring <= radius - 2 ? -1 : 1 });
  }
  const centerX = Math.floor(col * SAMPLES), centerY = Math.floor(row * SAMPLES);
  for (let dy = -SAMPLES; dy <= SAMPLES; dy++) for (let dx = -SAMPLES; dx <= SAMPLES; dx++) {
    for (let i = 0; i < pattern.length; i++) {
      const x = centerX + dx + pattern[i].x * SAMPLES, y = centerY + dy + pattern[i].y * SAMPLES;
      values[i] = exposure[i] = x >= 0 && x < width && y >= 0 && y < width ? pixels[y * width + x] : 0;
    }
    exposure.sort();
    const paper = exposure[Math.floor(.85 * exposure.length)];
    let count = 0, sum = 0, squares = 0, signs = 0, cross = 0;
    for (let i = 0; i < pattern.length; i++) {
      const value = values[i], sign = pattern[i].sign;
      if (!Number.isFinite(value) || value < .80 * paper) continue;
      sum += value; squares += value * value; signs += sign; cross += value * sign; count++;
    }
    if (count < pattern.length * .7) continue;
    const denom = (squares - sum * sum / count) * (count - signs * signs / count);
    if (denom <= 0) continue;
    const score = (cross - sum * signs / count) / Math.sqrt(denom) - .008 * (dx * dx + dy * dy) / SAMPLES ** 2;
    if (score > best.score) best = { score, col, row, x: col + (dx + .5) / SAMPLES, y: row + (dy + .5) / SAMPLES };
  }
  return best;
}

// A slightly misplaced grid still has a periodic signal at its module edges.
// Measure the phase of that signal locally to recenter samples between edges.
function alignCellEdges(pixels, map, size) {
  const width = size * SAMPLES, span = size + 1, shifts = [];
  const cos = [], sin = [];
  for (let k = 0; k < SAMPLES; k++) {
    cos.push(Math.cos(2 * Math.PI * k / SAMPLES)); sin.push(Math.sin(2 * Math.PI * k / SAMPLES));
  }
  for (const horizontal of [true, false]) {
    const stride = horizontal ? 1 : width;
    const real = new Float32Array(span * span), imaginary = new Float32Array(real.length);
    for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
      if (horizontal ? !x : !y) continue;
      const at = y * width + x, edge = Math.min(6, Math.abs(pixels[at] - pixels[at - stride]));
      const k = (horizontal ? x : y) % SAMPLES, cell = (1 + Math.floor(y / SAMPLES)) * span + 1 + Math.floor(x / SAMPLES);
      real[cell] += edge * cos[k]; imaginary[cell] += edge * sin[k];
    }
    for (let y = 1; y <= size; y++) for (let x = 1; x <= size; x++) {
      const i = y * span + x;
      for (const plane of [real, imaginary]) plane[i] += plane[i - 1] + plane[i - span] - plane[i - span - 1];
    }
    const shift = new Float32Array(span * span);
    for (let y = 0; y <= size; y++) for (let x = 0; x <= size; x++) {
      const top = Math.max(0, y - 5) * span, bottom = Math.min(size, y + 5) * span;
      const left = Math.max(0, x - 5), right = Math.min(size, x + 5);
      const sum = a => a[bottom + right] - a[bottom + left] - a[top + right] + a[top + left];
      shift[y * span + x] = Math.atan2(sum(imaginary), sum(real)) / (2 * Math.PI);
    }
    shifts.push(shift);
  }
  return (x, y) => {
    const col = Math.max(0, Math.min(size - 1, Math.floor(x))), row = Math.max(0, Math.min(size - 1, Math.floor(y)));
    const i = row * span + col, fx = x - col, fy = y - row;
    const offset = a => (1 - fy) * ((1 - fx) * a[i] + fx * a[i + 1]) +
      fy * ((1 - fx) * a[i + span] + fx * a[i + span + 1]);
    return map(Math.max(0, x + offset(shifts[0])), Math.max(0, y + offset(shifts[1])));
  };
}

export function refineShadowGrid(image, initialMap, version, shouldContinue) {
  const size = 17 + 4 * version, centers = alignmentCenters(version), width = size * SAMPLES;
  const pixels = sampleGrid(image, initialMap, size, shouldContinue);
  if (!pixels) return null;
  // Suppress grain before taking the brightest exposed part of each small patch.
  const local = smoothGrid(pixels, width, 1.25, 3), exposed = new Float32Array(local.length);
  for (let y = 1; y < width - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    exposed[i] = Math.max(local[i - width - 1], local[i - width], local[i - width + 1],
      local[i - 1], local[i], local[i + 1], local[i + width - 1], local[i + width], local[i + width + 1]);
  }
  const last = centers.length - 1, anchors = [];
  for (let r = 0; r <= last; r++) for (let c = 0; c <= last; c++) {
    if (!shouldContinue()) return null;
    const finder = (r === 0 && (c === 0 || c === last)) || (r === last && c === 0);
    const col = finder ? (c ? size - 3.5 : 3.5) : centers[c] + .5;
    const row = finder ? (r ? size - 3.5 : 3.5) : centers[r] + .5;
    const mark = locateMark(exposed, width, col, row, finder ? 3 : 2);
    if (mark.score >= .68) anchors.push(mark);
  }
  if (anchors.length < .75 * centers.length ** 2) return null;
  const corrected = bentModuleGrid(anchors, (x, y) => ({ x, y }), size, shouldContinue);
  if (!corrected) return null;
  const measured = (x, y) => {
    const p = corrected(x, y);
    return initialMap(Math.max(0, p.x), Math.max(0, p.y));
  };
  const aligned = sampleGrid(image, measured, size, shouldContinue);
  return aligned && alignCellEdges(aligned, measured, size);
}
