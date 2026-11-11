// A still-photo fallback for a light sheet against textured, darker surroundings.
// Follow coherent inward brightness changes along each side, then use the four
// measured curves to predict where the printed grid bends between the corners.
import { pageHomography } from "./pageAlignedScan.js";
import { solve3 } from "./qrAlignmentRefinement.js";

function preview(image) {
  const scale = Math.min(1, 384 / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const gray = new Uint8Array(width * height);
  const xs = width / image.width, ys = height / image.height;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
      const offset = (Math.floor((y + (dy + .5) / 3) / ys) * image.width
        + Math.floor((x + (dx + .5) / 3) / xs)) * 4;
      sum += image.data[offset] + image.data[offset + 1] + image.data[offset + 2];
    }
    gray[y * width + x] = sum / 27;
  }
  return { gray, width, height };
}

function fit(samples, quadratic) {
  const matrix = [[0, 0, 0], [0, 0, 0], [0, 0, quadratic ? 0 : 1]], rhs = [0, 0, 0];
  for (const { t, x } of samples) {
    const bases = [1, t, quadratic ? t * t : 0];
    for (let i = 0; i < 3; i++) {
      rhs[i] += bases[i] * x;
      for (let j = 0; j < 3; j++) matrix[i][j] += bases[i] * bases[j];
    }
  }
  const c = solve3(matrix, rhs);
  return c && (t => c[0] + t * (c[1] + t * c[2]));
}

function findEdge({ gray, width, height }, vertical, far, shouldContinue) {
  const along = vertical ? height : width, across = vertical ? width : height;
  const band = Math.max(2, Math.floor(across * .014));
  const lines = [];
  for (let i = 0; i < 49; i++) {
    const y = Math.round(along * (.23 + .54 * i / 48));
    const row = new Float32Array(across);
    for (let x = 1; x < across - 1; x++) {
      const c = far ? across - 1 - x : x;
      const at = vertical ? y * width + c : c * width + y;
      row[x] = (gray[at - width - 1] + gray[at - width] + gray[at - width + 1]
        + gray[at - 1] + gray[at] + gray[at + 1]
        + gray[at + width - 1] + gray[at + width] + gray[at + width + 1]) / 9;
    }
    const votes = new Float32Array(across), weights = new Float32Array(across);
    for (let x = band + 1; x < across - band - 1; x++) {
      const wide = Math.max(0, row[x + band] - row[x - band] - 6);
      const narrow = Math.max(0, row[x + 1] - row[x - 1] - 2);
      votes[x] = Math.sqrt(wide) + .7 * Math.sqrt(narrow);
      weights[x] = wide * Math.max(0, narrow - 1) ** 2;
    }
    lines.push({ t: y / along - .5, votes, weights });
  }
  let score = 0, intercept = 0, slope = 0;
  for (let k = 0; k <= 29; k++) {
    if (!shouldContinue()) return null;
    const angle = -.36 + .025 * k;
    const offsets = lines.map(line => Math.round(angle * line.t * along));
    for (let x = band; x < across * .48; x++) {
      let sum = 0;
      for (let i = 0; i < lines.length; i++) sum += lines[i].votes[x + offsets[i]] || 0;
      if (sum > score) { score = sum; intercept = x; slope = angle; }
    }
  }
  if (score < 4 * lines.length) return null;
  let samples = [];
  for (const { t, weights } of lines) {
    const center = Math.round(intercept + slope * t * along);
    let sum = 0, total = 0;
    for (let x = Math.max(0, center - band - 2); x <= Math.min(across - 1, center + band + 2); x++) {
      sum += x * weights[x]; total += weights[x];
    }
    if (total > 1) samples.push({ t, x: sum / total });
  }
  for (let i = 0; i < 3; i++) {
    if (samples.length < lines.length / 2) return null;
    const line = fit(samples, false);
    if (!line) return null;
    samples = samples.filter(p => Math.abs(line(p.t) - p.x) < 3);
  }
  if (samples.length < lines.length / 2) return null;
  const curve = fit(samples, true);
  return curve && (position => {
    const x = curve(position / along - .5);
    return far ? across - 1 - x : x;
  });
}

export function curvedPaperMapping(image, shouldContinue) {
  const sample = preview(image), { width, height } = sample;
  if (Math.min(width, height) < 40) return null;
  const sides = [];
  for (const [vertical, far] of [[true, false], [true, true], [false, false], [false, true]]) {
    const edge = findEdge(sample, vertical, far, shouldContinue);
    if (!edge) return null;
    sides.push(edge);
  }
  const [left, right, top, bottom] = sides;
  const corners = [[left, top], [right, top], [right, bottom], [left, bottom]].map(([side, end]) => {
    let x = width / 2;
    for (let i = 0; i < 6; i++) x = side(end(x));
    return { x, y: end(x) };
  });
  if (corners.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) ||
      p.x < 0 || p.x >= width || p.y < 0 || p.y >= height)) return null;
  const [tl, tr, br, bl] = corners;
  if (Math.min(tr.x - tl.x, br.x - bl.x) < .35 * width ||
      Math.min(bl.y - tl.y, br.y - tr.y) < .35 * height) return null;
  const sx = image.width / width, sy = image.height / height;
  const base = pageHomography(corners.map(p => ({ x: (p.x + .5) * sx - .5, y: (p.y + .5) * sy - .5 })));
  if (!base) return null;
  const sag = (curve, a, b) => curve((a + b) / 2) - (curve(a) + curve(b)) / 2;
  const t = sag(top, tl.x, tr.x), b = sag(bottom, bl.x, br.x);
  const l = sag(left, tl.y, bl.y), r = sag(right, tr.y, br.y);
  if (Math.max(Math.abs(t), Math.abs(b)) > .08 * height || Math.max(Math.abs(l), Math.abs(r)) > .08 * width) return null;
  return (u, v) => {
    const p = base(u, v);
    return { x: p.x + 4 * v * (1 - v) * ((1 - u) * l + u * r) * sx,
      y: p.y + 4 * u * (1 - u) * ((1 - v) * t + v * b) * sy };
  };
}
