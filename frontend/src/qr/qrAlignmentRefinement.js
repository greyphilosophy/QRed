// Recover QR module locations from public alignment patterns on a photographed
// page. No original PDF, signing keys, or expected QR payload enters this path.
import { alignmentCenters } from "./qrLowLevel.js";

const DARK = new Uint8Array(25);
for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++)
  DARK[row * 5 + col] = Number(row === 0 || row === 4 || col === 0 || col === 4 ||
    (row === 2 && col === 2));
const OFFSETS = [-0.2, 0.2];

function grayAt(image, x, y) {
  const sx = Math.round(x), sy = Math.round(y);
  if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) return 0;
  const index = (sy * image.width + sx) * 4;
  return (image.data[index] + image.data[index + 1] + image.data[index + 2]) / 3;
}

function matchScore(image, cx, cy, ux, uy, vx, vy) {
  let sum = 0, sumSq = 0, sumP = 0, sumPSq = 0, cross = 0, n = 0;
  for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) {
    const pattern = DARK[row * 5 + col] ? -1 : 1;
    for (const oy of OFFSETS) for (const ox of OFFSETS) {
      const x = cx + (col - 2 + ox) * ux + (row - 2 + oy) * vx;
      const y = cy + (col - 2 + ox) * uy + (row - 2 + oy) * vy;
      const pixel = grayAt(image, x, y);
      if (!pixel) return -1;
      sum += pixel; sumSq += pixel * pixel;
      sumP += pattern; sumPSq += pattern * pattern;
      cross += pattern * pixel; n++;
    }
  }
  const variance = sumSq - sum * sum / n, patternVariance = sumPSq - sumP * sumP / n;
  return variance > 0 && patternVariance > 0
    ? (cross - sumP * sum / n) / Math.sqrt(variance * patternVariance) : 0;
}

function locateAlignment(image, expected, ux, uy, vx, vy) {
  let best = { score: -1, x: expected.x, y: expected.y };
  const tryShift = (dx, dy, scale) => {
    const score = matchScore(image, expected.x + dx, expected.y + dy,
      ux * scale, uy * scale, vx * scale, vy * scale);
    if (score > best.score) best = { score, x: expected.x + dx, y: expected.y + dy, scale };
  };
  for (const scale of [0.97, 1, 1.03])
    for (let dy = -39; dy <= 39; dy += 3)
      for (let dx = -39; dx <= 39; dx += 3) tryShift(dx, dy, scale);
  const dx = best.x - expected.x, dy = best.y - expected.y;
  for (let y = dy - 3; y <= dy + 3; y++)
    for (let x = dx - 3; x <= dx + 3; x++) tryShift(x, y, best.scale || 1);
  return best;
}

function solve3(matrix, vector) {
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let j = i + 1; j < 3; j++)
      if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    if (Math.abs(a[pivot][i]) < 1e-8) return null;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const factor = 1 / a[i][i];
    for (let j = i; j < 4; j++) a[i][j] *= factor;
    for (let j = 0; j < 3; j++) if (j !== i) {
      const f = a[j][i];
      for (let k = i; k < 4; k++) a[j][k] -= f * a[i][k];
    }
  }
  return a.map(row => row[3]);
}

function fitAffine(points, weights) {
  const matrix = Array.from({ length: 3 }, () => [0, 0, 0]);
  const x = [0, 0, 0], y = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const p = points[i], w = weights[i], v = [p.col, p.row, 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) matrix[a][b] += w * v[a] * v[b];
      x[a] += w * v[a] * p.x;
      y[a] += w * v[a] * p.y;
    }
  }
  const xx = solve3(matrix, x), yy = solve3(matrix, y);
  return xx && yy ? { x: xx, y: yy } : null;
}
function predicted(aff, col, row) {
  return { x: aff.x[0] * col + aff.x[1] * row + aff.x[2],
    y: aff.y[0] * col + aff.y[1] * row + aff.y[2] };
}
function bracket(centers, value) {
  const n = centers.length;
  if (value <= centers[0]) return [0, 1, 0];
  if (value >= centers[n - 1]) return [n - 2, n - 1, 1];
  for (let i = 0; i < n - 1; i++) if (value <= centers[i + 1])
    return [i, i + 1, (value - centers[i]) / (centers[i + 1] - centers[i])];
  return [n - 2, n - 1, 1];
}

// A QR v27 has 22 independent 5x5 alignment patterns. Match them locally,
// fit a robust affine grid, then interpolate small residual distortions
// throughout each QR independently. All observations come from the photo.
export function refineQrModuleGrid(image, pageMapping, region, version) {
  const centers = alignmentCenters(version);
  if (centers.length < 3) return null;
  const size = 17 + 4 * version, points = [];
  const map = (col, row) => pageMapping(
    region.x + region.width * col / size,
    region.y + region.height * row / size);
  for (let ri = 0; ri < centers.length; ri++)
    for (let ci = 0; ci < centers.length; ci++) {
      const row = centers[ri], col = centers[ci];
      if ((ri === 0 && ci === 0) || (ri === 0 && ci === centers.length - 1) ||
          (ri === centers.length - 1 && ci === 0)) continue;
      const cc = col + 0.5, rr = row + 0.5;
      const expected = map(cc, rr);
      const right = map(cc + 1, rr), down = map(cc, rr + 1);
      const found = locateAlignment(image, expected, right.x - expected.x,
        right.y - expected.y, down.x - expected.x, down.y - expected.y);
      if (found.score >= 0.60) points.push({
        col: cc, row: rr, x: found.x, y: found.y, score: found.score, ri, ci,
      });
    }
  if (points.length < Math.max(7, Math.floor((centers.length ** 2 - 3) * 0.5)))
    return null;
  let weights = points.map(p => Math.max(0.05, (p.score - 0.35) ** 2));
  let aff = fitAffine(points, weights);
  if (!aff) return null;
  for (let iteration = 0; iteration < 3; iteration++) {
    const errors = points.map(p => {
      const v = predicted(aff, p.col, p.row);
      return Math.hypot(p.x - v.x, p.y - v.y);
    });
    weights = points.map((p, i) =>
      Math.max(0.002, (p.score - 0.35) ** 2) *
      Math.min(1, (7 / Math.max(0.001, errors[i])) ** 2));
    const next = fitAffine(points, weights);
    if (!next) break;
    aff = next;
  }
  const m = centers.length, grid = Array.from({ length: m * m }, () => null);
  for (const p of points) {
    const v = predicted(aff, p.col, p.row);
    const dx = p.x - v.x, dy = p.y - v.y;
    if (Math.hypot(dx, dy) < 7) grid[p.ri * m + p.ci] = { dx, dy };
  }
  const inlierCount = grid.filter(Boolean).length;
  if (inlierCount < 7) return null;
  for (let row = 0; row < m; row++) for (let col = 0; col < m; col++) {
    const index = row * m + col;
    if (grid[index]) continue;
    const neighbors = [];
    for (let i = 0; i < m * m; i++) if (grid[i]) {
      const y = Math.floor(i / m), x = i % m;
      neighbors.push({ distance: (x - col) ** 2 + (y - row) ** 2, value: grid[i] });
    }
    neighbors.sort((a, b) => a.distance - b.distance);
    let dx = 0, dy = 0, sum = 0;
    for (const item of neighbors.slice(0, 3)) {
      const w = 1 / (1 + item.distance);
      dx += w * item.value.dx;
      dy += w * item.value.dy;
      sum += w;
    }
    grid[index] = { dx: dx / sum, dy: dy / sum };
  }
  const markers = centers.map(c => c + 0.5);
  const moduleMap = (col, row) => {
    const p = predicted(aff, col, row);
    const [x0, x1, fx] = bracket(markers, col);
    const [y0, y1, fy] = bracket(markers, row);
    const a = grid[y0 * m + x0], b = grid[y0 * m + x1];
    const c = grid[y1 * m + x0], d = grid[y1 * m + x1];
    return {
      x: p.x + (a.dx * (1 - fx) + b.dx * fx) * (1 - fy) +
        (c.dx * (1 - fx) + d.dx * fx) * fy,
      y: p.y + (a.dy * (1 - fx) + b.dy * fx) * (1 - fy) +
        (c.dy * (1 - fx) + d.dy * fx) * fy,
    };
  };
  return { moduleMap, quality: inlierCount / (m * m - 3) };
}
