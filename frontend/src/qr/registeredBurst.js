import { solveLinearSystem } from "./linearSystem.js";

// Match small patches throughout the page. All coordinates here refer to the
// first original exposure. The comparison/OCR canvas never uses this merge.
const PATCH_RADIUS = 22;
const luma = (data, i) => (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) / 256;

function preview(image, step) {
  const width = Math.floor(image.width / step), height = Math.floor(image.height / step);
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let dy = 0; dy < step; dy++) {
      let i = 4 * ((y * step + dy) * image.width + x * step);
      for (let dx = 0; dx < step; dx++, i += 4) sum += luma(image.data, i);
    }
    gray[y * width + x] = Math.round(sum / (step * step));
  }
  return { gray, width, height };
}

function matchPatch(a, b, x, y) {
  const radius = PATCH_RADIUS, offsets = [], ref = [];
  for (let dy = -radius; dy <= radius; dy += 2) for (let dx = -radius; dx <= radius; dx += 2) {
    const i = (y + dy) * a.width + x + dx;
    offsets.push(i); ref.push(a.gray[i]);
  }
  const mean = ref.reduce((sum, v) => sum + v, 0) / ref.length;
  const centered = ref.map(v => v - mean), power = centered.reduce((sum, v) => sum + v * v, 0);
  if (power < 15 * ref.length) return null;
  function score(dx, dy) {
    const shift = dy * a.width + dx;
    let sum = 0, square = 0, cross = 0;
    for (let k = 0; k < offsets.length; k++) {
      const v = b.gray[offsets[k] + shift];
      sum += v; square += v * v; cross += v * centered[k];
    }
    const variance = square - sum * sum / ref.length;
    return variance > 0 ? cross / Math.sqrt(variance * power) : 0;
  }
  let best = -1, bx = 0, by = 0;
  // Only a short shutter burst is eligible. Reject large motion before blending.
  for (let dy = -9; dy <= 9; dy++) for (let dx = -9; dx <= 9; dx++) {
    const value = score(dx, dy);
    if (value > best) { best = value; bx = dx; by = dy; }
  }
  if (best < .50 || Math.abs(bx) === 9 || Math.abs(by) === 9) return null;
  function subpixel(left, right) {
    const curvature = 2 * (left + right - 2 * best);
    return curvature < -.002 ? Math.max(-.5, Math.min(.5, (left - right) / curvature)) : 0;
  }
  return { x, y, dx: bx + subpixel(score(bx - 1, by), score(bx + 1, by)),
    dy: by + subpixel(score(bx, by - 1), score(bx, by + 1)) };
}

function fit(points) {
  const matrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], dx = [0, 0, 0], dy = [0, 0, 0];
  for (const p of points) {
    const v = [p.x, p.y, 1];
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) matrix[j][k] += v[j] * v[k];
      dx[j] += v[j] * p.dx; dy[j] += v[j] * p.dy;
    }
  }
  const ax = solveLinearSystem(matrix, dx), ay = solveLinearSystem(matrix, dy);
  return ax && ay ? { ax, ay } : null;
}
const at = (coeff, x, y) => coeff[0] * x + coeff[1] * y + coeff[2];

function sameSamples(first, next) {
  // Some cameras repeat a buffered exposure. It contains no independent
  // noise sample and must not earn another vote in the average.
  const stride = Math.max(1, Math.floor(first.length / (4 * 8192))) * 4;
  for (let i = 0; i < first.length; i += stride) {
    if (first[i] !== next[i] || first[i + 1] !== next[i + 1] || first[i + 2] !== next[i + 2]) return false;
  }
  return true;
}

function registration(a, b) {
  const points = [];
  for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) {
    const x = Math.round(a.width * (.17 + .165 * col)), y = Math.round(a.height * (.17 + .165 * row));
    if (Math.min(x, a.width - x, y, a.height - y) <= PATCH_RADIUS + 10) continue;
    const point = matchPatch(a, b, x, y);
    if (point) points.push(point);
  }
  if (points.length < 13) return null;
  let best = [];
  for (let i = 0; i < points.length - 2; i++) for (let j = i + 1; j < points.length - 1; j++) {
    for (let k = j + 1; k < points.length; k++) {
      const guess = fit([points[i], points[j], points[k]]);
      if (!guess) continue;
      const support = points.filter(p => Math.hypot(at(guess.ax, p.x, p.y) - p.dx,
        at(guess.ay, p.x, p.y) - p.dy) < .50);
      if (support.length > best.length) best = support;
    }
  }
  if (best.length < Math.max(13, .70 * points.length)) return null;
  // Inliers concentrated on one corner cannot establish registration across a page.
  for (const sideX of [-1, 1]) for (const sideY of [-1, 1]) {
    if (!best.some(p => sideX * (p.x / a.width - .5) > .10 && sideY * (p.y / a.height - .5) > .10)) return null;
  }
  return fit(best);
}

export function stackRegisteredBurst(reference, extraFrames) {
  const { width, height, data } = reference;
  if (!extraFrames?.length || width * height > 12_000_000 || data.length !== width * height * 4) return reference;
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 1050));
  let first;
  const frames = [];
  for (const next of extraFrames.slice(0, 2)) {
    if (next.width !== width || next.height !== height || next.data.length !== data.length) continue;
    if (sameSamples(data, next.data) || frames.some(f => sameSamples(f.pixels, next.data))) continue;
    first ??= preview(reference, step);
    const map = registration(first, preview(next, step));
    if (map) frames.push({ ...map, pixels: next.data });
  }
  if (!frames.length) return reference;
  const output = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, red = data[i], green = data[i + 1], blue = data[i + 2];
    let r = red, g = green, b = blue, count = 1;
    for (const { ax, ay, pixels } of frames) {
      const px = x + step * at(ax, (x + .5) / step - .5, (y + .5) / step - .5);
      const py = y + step * at(ay, (x + .5) / step - .5, (y + .5) / step - .5);
      const xx = Math.floor(px), yy = Math.floor(py);
      if (xx < 0 || yy < 0 || xx + 1 >= width || yy + 1 >= height) continue;
      const index = (yy * width + xx) * 4, fx = px - xx, fy = py - yy;
      const sample = c => (1 - fy) * ((1 - fx) * pixels[index + c] + fx * pixels[index + c + 4])
        + fy * ((1 - fx) * pixels[index + c + width * 4] + fx * pixels[index + c + width * 4 + 4]);
      const nr = sample(0), ng = sample(1), nb = sample(2);
      // Exclude moving foreground, changed print or local specular highlights.
      if (Math.max(Math.abs(nr - red), Math.abs(ng - green), Math.abs(nb - blue)) > 54) continue;
      r += nr; g += ng; b += nb; count++;
    }
    output[i] = r / count; output[i + 1] = g / count; output[i + 2] = b / count; output[i + 3] = 255;
  }
  return { width, height, data: output };
}
