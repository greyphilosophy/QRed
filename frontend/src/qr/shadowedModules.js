// Read pale print across a shadow boundary. Neighboring modules share a
// physical edge, so their relative brightness can survive a local change in
// illumination that makes absolute paper/ink levels ambiguous.
import { SAMPLES, smoothGrid } from "./shadowedGrid.js";

const clamp = (x, low, high) => Math.max(low, Math.min(high, x));

function localPercentile(values, size, radius, fraction) {
  const out = new Float32Array(values.length), width = 2 * radius + 1, samples = new Float32Array(width * width);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let k = 0;
    for (let j = -radius; j <= radius; j++) for (let i = -radius; i <= radius; i++)
      samples[k++] = values[clamp(y + j, 0, size - 1) * size + clamp(x + i, 0, size - 1)];
    samples.sort(); out[y * size + x] = samples[Math.floor(fraction * samples.length)];
  }
  return out;
}

function readLevels(pixels, size) {
  const high = new Float32Array(size * size), low = new Float32Array(high.length);
  const inner = new Float32Array(16), cell = new Float32Array(36), width = size * SAMPLES;
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    let n = 0, k = 0;
    for (let y = 1; y <= 6; y++) for (let x = 1; x <= 6; x++) {
      const level = Math.log(Math.max(1, pixels[(row * SAMPLES + y) * width + col * SAMPLES + x]));
      cell[n++] = level;
      if (x >= 2 && x <= 5 && y >= 2 && y <= 5) inner[k++] = level;
    }
    inner.sort(); cell.sort();
    high[row * size + col] = inner[12]; low[row * size + col] = cell[5];
  }
  // Estimate ink depth from this print. Multiplicative exposure becomes an
  // additive offset in log luminance. Reject overprinted strokes as outliers.
  const light = localPercentile(high, size, 4, .8), dark = localPercentile(high, size, 4, .25);
  const gaps = light.map((value, i) => value - dark[i]).sort();
  const inkDepth = gaps[Math.floor(gaps.length / 2)];
  if (inkDepth < .025 || inkDepth > .6) return null;
  const paper = smoothGrid(localPercentile(high, size, 2, .8), size, .9);
  for (let pass = 0; pass < 6; pass++) {
    const weights = new Float32Array(high.length), offsets = new Float32Array(high.length);
    for (let i = 0; i < high.length; i++) {
      const error = high[i] - paper[i] + (paper[i] - high[i] > inkDepth * .5 ? inkDepth : 0);
      weights[i] = Math.exp(-.5 * (error / (.30 * inkDepth)) ** 2);
      offsets[i] = error * weights[i];
    }
    const weight = smoothGrid(weights, size, 1.4), offset = smoothGrid(offsets, size, 1.4);
    for (let i = 0; i < high.length; i++) paper[i] += offset[i] / Math.max(.03, weight[i]);
  }
  return { high, low, paper, inkDepth };
}

const median3 = (a, b, c) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

function measureEdges(pixels, size, levels, vertical) {
  const { paper, inkDepth } = levels, width = size * SAMPLES;
  const change = new Float32Array(size * size), weight = new Float32Array(change.length);
  const across = vertical ? width : 1, along = vertical ? 1 : width;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (!(vertical ? y : x)) continue;
    const i = y * size + x, base = y * SAMPLES * width + x * SAMPLES;
    let total = 0, sum = 0, squared = 0;
    for (let k = 1; k <= 6; k++) {
      const at = base + along * k;
      const read = s => Math.log(Math.max(1, pixels[at + across * s]));
      const a = read(1), b = read(2), c = read(3), d = read(-4), e = read(-3), f = read(-2);
      const slope = (read(4) - a + f - read(-5)) / 2;
      const delta = clamp((median3(a, b, c) - median3(d, e, f) - .45 * slope) / inkDepth, -1.3, 1.3);
      const exposed = Math.exp(-3 * Math.max(0, (paper[i] - (b + e) / 2) / inkDepth - 1.2));
      total += exposed; sum += exposed * delta; squared += exposed * delta * delta;
    }
    change[i] = sum / Math.max(.03, total);
    weight[i] = total / 6 * Math.exp(-2 * Math.sqrt(Math.max(0, squared / Math.max(.03, total) - change[i] ** 2)));
  }
  // Blurred edges lose contrast. Calibrate horizontal and vertical readings
  // independently since even slight directional camera motion affects them differently.
  const gain = localPercentile(change.map(Math.abs), size, 5, .72);
  for (let i = 0; i < change.length; i++) change[i] /= clamp(gain[i], .37, 1.15);
  return { change, weight };
}

export function classifyShadowedModules(pixels, size, shouldContinue) {
  if (!pixels || !shouldContinue()) return null;
  const levels = readLevels(pixels, size);
  if (!levels || !shouldContinue()) return null;
  const { high, low, paper, inkDepth } = levels;
  const count = size * size, prior = new Float32Array(count), coverage = new Float32Array(count);
  const ink = new Float32Array(count), normalized = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const level = normalized[i] = 1 + (high[i] - paper[i]) / inkDepth;
    const spread = (high[i] - low[i]) / inkDepth;
    coverage[i] = clamp(spread - .42, 0, 5);
    prior[i] = .45 * clamp(2 * level - 1, -1, 1) * Math.exp(-coverage[i] - Math.max(0, -level));
    ink[i] = Number(Math.abs(level) < .44 && spread < .9);
  }
  const texture = smoothGrid(ink, size, 1.5);
  // An opaque navigation QR or logo can hide the watermark under a white
  // backing as well as under black ink. Dilate measured patches lacking
  // exposed pale ink by a few modules to include the edges of the graphic.
  const missing = new Uint8Array(count);
  for (let y = 3; y < size - 3; y++) for (let x = 3; x < size - 3; x++) {
    let exposed = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++)
      exposed += ink[(y + dy) * size + x + dx];
    if (exposed > 2) continue;
    for (let dy = -2; dy <= 2; dy++) missing.fill(1, (y + dy) * size + x - 2, (y + dy) * size + x + 3);
  }
  const edges = [
    measureEdges(pixels, size, levels, true), measureEdges(pixels, size, levels, false),
  ];
  // For each edge, score the three possible physical observations (lighter,
  // equal, darker). Pass evidence from neighboring cells without returning
  // the same message along the edge it arrived on.
  const directions = [-size, size, -1, 1];
  const messages = directions.map(() => new Float32Array(count));
  const potentials = directions.map(() => new Float32Array(count * 3));
  for (let k = 0; k < 4; k++) {
    const { change, weight } = edges[k >> 1], delta = directions[k];
    for (let i = 0; i < count; i++) {
      const j = i + delta;
      if (j < 0 || j >= count || (k >= 2 && Math.floor(i / size) !== Math.floor(j / size))) continue;
      const at = k % 2 ? j : i, s = k % 2 ? -change[at] : change[at], w = weight[at];
      const equal = -Math.min(3.5, s * s / .8);
      potentials[k][3 * i] = Math.exp(w * (-Math.min(5, (s - 1) ** 2 / .8) - equal));
      potentials[k][3 * i + 1] = Math.exp(w * (-Math.min(5, (s + 1) ** 2 / .8) - equal));
      potentials[k][3 * i + 2] = w;
    }
  }
  const odds = prior.slice();
  for (let pass = 0; pass < 5; pass++) {
    if (!shouldContinue()) return null;
    const next = directions.map(() => new Float32Array(count));
    for (let k = 0; k < 4; k++) for (let i = 0; i < count; i++) {
      const e = potentials[k], w = e[3 * i + 2];
      if (!w) continue;
      const j = i + directions[k], neighbor = Math.exp(odds[j] - messages[k ^ 1][j]);
      next[k][i] = w * clamp(Math.log((neighbor + e[3 * i]) / (neighbor * e[3 * i + 1] + 1)), -2.5, 2.5);
    }
    odds.set(prior);
    for (let k = 0; k < 4; k++) {
      messages[k] = next[k];
      for (let i = 0; i < count; i++) odds[i] += messages[k][i];
    }
  }
  const bits = new Uint8Array(count), unknown = new Uint8Array(count), reliability = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    bits[i] = Number(odds[i] < 0);
    reliability[i] = Math.abs(odds[i]) * Math.exp(-.7 * coverage[i] - 1.25 * Math.max(0, -normalized[i] - .1))
      * clamp(texture[i] / .32, .01, 1) ** 1.5 * (missing[i] ? .025 : 1);
    unknown[i] = 1; // The parity decoder ranks these bounded, per-block observations.
  }
  return { size, bits, unknown, reliability };
}
