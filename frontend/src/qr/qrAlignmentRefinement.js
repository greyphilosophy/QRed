// Recover QR module locations from public alignment patterns on a photographed
// page. No original PDF, signing keys, or expected QR payload enters this path.
import { alignmentCenters } from "./qrLowLevel.js";
import { photoLuminance } from "./paperColor.js";

const DARK = new Uint8Array(25);
for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++)
  DARK[row * 5 + col] = Number(row === 0 || row === 4 || col === 0 || col === 4 ||
    (row === 2 && col === 2));
const OFFSETS = [-0.2, 0.2];
const MAX_ALIGNMENT_CACHE_PIXELS = 65_536;

function alignmentLuminance(image, expected, ux, uy, vx, vy, searchRadius) {
  // Sample only this marker's bounded neighborhood once. A wide search visits
  // the same pixels thousands of times; do not convert the whole phone image
  // or retain a cache after the marker has been matched.
  const reachX = searchRadius + 4 + 2.2 * 1.03 * (Math.abs(ux) + Math.abs(vx));
  const reachY = searchRadius + 4 + 2.2 * 1.03 * (Math.abs(uy) + Math.abs(vy));
  const left = Math.max(0, Math.floor(expected.x - reachX));
  const top = Math.max(0, Math.floor(expected.y - reachY));
  const right = Math.min(image.width - 1, Math.ceil(expected.x + reachX));
  const bottom = Math.min(image.height - 1, Math.ceil(expected.y + reachY));
  const width = Math.max(0, right - left + 1), height = Math.max(0, bottom - top + 1);
  // Preserve double-precision luminance, including thirds, for exactly the
  // same matching scores and tie-breaking as direct source-pixel reads.
  if (width * height > MAX_ALIGNMENT_CACHE_PIXELS)
    return { ...image, left: 0, top: 0, gray: null };
  const gray = new Float64Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    gray[y * width + x] = photoLuminance(image, ((top + y) * image.width + left + x) * 4);
  return { gray, width, height, left, top };
}

function grayAt(image, x, y) {
  const sx = Math.round(x) - image.left, sy = Math.round(y) - image.top;
  if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) return 0;
  return image.gray ? image.gray[sy * image.width + sx]
    : photoLuminance(image, (sy * image.width + sx) * 4);
}

// Every candidate for one scale reads the same four positions within each
// public pattern module. Prepare the products once, preserving their original
// addition order so floating-point rounding chooses the same photo pixels.
function alignmentSamples(ux, uy, vx, vy) {
  const x = new Float64Array(200), y = new Float64Array(200);
  let index = 0;
  for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++)
    for (const oy of OFFSETS) for (const ox of OFFSETS) {
      x[index] = (col - 2 + ox) * ux; y[index++] = (col - 2 + ox) * uy;
      x[index] = (row - 2 + oy) * vx; y[index++] = (row - 2 + oy) * vy;
    }
  return { x, y };
}

function matchScore(image, cx, cy, samples, values) {
  const { x, y } = samples;
  let paper = 0, sum = 0, sumSq = 0, sumP = 0, sumPSq = 0, cross = 0, n = 0;
  if (values) {
    for (let module = 0; module < 25; module++) {
      let best = 0;
      for (let index = module * 8; index < module * 8 + 8; index += 2)
        best = Math.max(best, grayAt(image,
          cx + x[index] + x[index + 1], cy + y[index] + y[index + 1]));
      values[module] = best;
      paper = Math.max(paper, best);
    }
    // Letter strokes are darker than the pale watermark. Compare exposed
    // pixels within each module and discard fully obscured modules, while
    // requiring at least two thirds of the public pattern as real evidence.
    for (let i = 0; i < values.length; i++) {
      const pixel = values[i];
      if (pixel < paper * 0.75) continue;
      const pattern = DARK[i] ? -1 : 1;
      sum += pixel; sumSq += pixel * pixel;
      sumP += pattern; sumPSq += pattern * pattern;
      cross += pattern * pixel; n++;
    }
  } else {
    for (let index = 0; index < 200; index += 2) {
      const pixel = grayAt(image,
        cx + x[index] + x[index + 1], cy + y[index] + y[index + 1]);
      if (!pixel) return -1;
      const pattern = DARK[Math.floor(index / 8)] ? -1 : 1;
      sum += pixel; sumSq += pixel * pixel;
      sumP += pattern; sumPSq += pattern * pattern;
      cross += pattern * pixel; n++;
    }
  }
  if (n < 17) return -1;
  const variance = sumSq - sum * sum / n, patternVariance = sumPSq - sumP * sumP / n;
  return variance > 0 && patternVariance > 0
    ? (cross - sumP * sum / n) / Math.sqrt(variance * patternVariance) : 0;
}

function locateAlignment(image, expected, ux, uy, vx, vy, foregroundRobust, searchRadius) {
  image = alignmentLuminance(image, expected, ux, uy, vx, vy, searchRadius);
  let best = { score: -1, x: expected.x, y: expected.y };
  // Reuse this tiny scratch array rather than allocating once per shift.
  const values = foregroundRobust ? new Float32Array(25) : null;
  const samples = new Map([0.97, 1, 1.03].map(scale =>
    [scale, alignmentSamples(ux * scale, uy * scale, vx * scale, vy * scale)]));
  const tryShift = (dx, dy, scale) => {
    const score = matchScore(image, expected.x + dx, expected.y + dy,
      samples.get(scale), values);
    const tied = foregroundRobust && Math.abs(score - best.score) < 1e-7;
    const closer = dx * dx + dy * dy < (best.x - expected.x) ** 2 + (best.y - expected.y) ** 2;
    if (score > best.score + (foregroundRobust ? 1e-7 : 0) || (tied && closer))
      best = { score, x: expected.x + dx, y: expected.y + dy, scale };
  };
  for (const scale of [0.97, 1, 1.03])
    for (let dy = -searchRadius; dy <= searchRadius; dy += 3)
      for (let dx = -searchRadius; dx <= searchRadius; dx += 3) tryShift(dx, dy, scale);
  const dx = best.x - expected.x, dy = best.y - expected.y;
  for (let y = dy - 3; y <= dy + 3; y++)
    for (let x = dx - 3; x <= dx + 3; x++) tryShift(x, y, best.scale || 1);
  return best;
}

export function solve3(matrix, vector) {
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
function bracket(centers, value, extrapolate) {
  const n = centers.length;
  // Continue the fitted distortion through the small outer strip beyond the
  // last alignment marker instead of introducing a flat, displaced border.
  if (value <= centers[0]) return [0, 1, extrapolate ? (value - centers[0]) / (centers[1] - centers[0]) : 0];
  if (value >= centers[n - 1]) return [n - 2, n - 1,
    extrapolate ? (value - centers[n - 2]) / (centers[n - 1] - centers[n - 2]) : 1];
  for (let i = 0; i < n - 1; i++) if (value <= centers[i + 1])
    return [i, i + 1, (value - centers[i]) / (centers[i + 1] - centers[i])];
  return [n - 2, n - 1, 1];
}

// A QR v27 has 22 independent 5x5 alignment patterns. Match them locally,
// fit a robust affine grid, then interpolate small residual distortions
// throughout each QR independently. All observations come from the photo.
export function refineQrModuleGrid(image, pageMapping, region, version, {
  foregroundRobust = false, searchRadius = 39, shouldContinue = () => true, measuredFinders = false,
} = {}) {
  const centers = alignmentCenters(version);
  if (centers.length < 3) return null;
  const size = 17 + 4 * version, points = [];
  const map = (col, row) => pageMapping(
    region.x + region.width * col / size,
    region.y + region.height * row / size);
  const middle = map(size / 2, size / 2);
  const right = map(size / 2 + 1, size / 2), down = map(size / 2, size / 2 + 1);
  const tolerance = foregroundRobust ? Math.max(7, Math.min(
    Math.hypot(right.x - middle.x, right.y - middle.y),
    Math.hypot(down.x - middle.x, down.y - middle.y))) : 7;
  for (let ri = 0; ri < centers.length; ri++)
    for (let ci = 0; ci < centers.length; ci++) {
      if (!shouldContinue()) return null;
      const row = centers[ri], col = centers[ci];
      if ((ri === 0 && ci === 0) || (ri === 0 && ci === centers.length - 1) ||
          (ri === centers.length - 1 && ci === 0)) continue;
      const cc = col + 0.5, rr = row + 0.5;
      const expected = map(cc, rr);
      const right = map(cc + 1, rr), down = map(cc, rr + 1);
      const found = locateAlignment(image, expected, right.x - expected.x,
        right.y - expected.y, down.x - expected.x, down.y - expected.y, foregroundRobust, searchRadius);
      if (found.score >= 0.60) points.push({
        col: cc, row: rr, x: found.x, y: found.y, score: found.score, ri, ci,
      });
    }
  // Versions 7–13 have only six alignment markers after excluding finders.
  // Require every one rather than an impossible seven; larger grids retain
  // their existing seven-inlier minimum and majority candidate gate.
  const minimumInliers = Math.min(7, centers.length ** 2 - 3);
  if (points.length < Math.max(minimumInliers, Math.floor((centers.length ** 2 - 3) * 0.5)))
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
      Math.min(1, (tolerance / Math.max(0.001, errors[i])) ** 2));
    const next = fitAffine(points, weights);
    if (!next) break;
    aff = next;
  }
  const m = centers.length, grid = Array.from({ length: m * m }, () => null);
  for (const p of points) {
    const v = predicted(aff, p.col, p.row);
    const dx = p.x - v.x, dy = p.y - v.y;
    if (Math.hypot(dx, dy) < tolerance) grid[p.ri * m + p.ci] = { dx, dy };
  }
  const inlierCount = grid.filter(Boolean).length;
  if (inlierCount < minimumInliers) return null;
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
  function mapWith(offsets) {
    return (col, row) => {
      const p = predicted(aff, col, row);
      const [x0, x1, fx] = bracket(markers, col, foregroundRobust);
      const [y0, y1, fy] = bracket(markers, row, foregroundRobust);
      const a = offsets[y0 * m + x0], b = offsets[y0 * m + x1];
      const c = offsets[y1 * m + x0], d = offsets[y1 * m + x1];
      return {
        x: p.x + (a.dx * (1 - fx) + b.dx * fx) * (1 - fy) +
          (c.dx * (1 - fx) + d.dx * fx) * fy,
        y: p.y + (a.dy * (1 - fx) + b.dy * fx) * (1 - fy) +
          (c.dy * (1 - fx) + d.dy * fx) * fy,
      };
    };
  }
  const result = { moduleMap: mapWith(grid), quality: inlierCount / (m * m - 3) };
  // A shift of half a module can move a sample into a neighboring cell.
  const halfPitch = Math.min(Math.hypot(right.x - middle.x, right.y - middle.y),
    Math.hypot(down.x - middle.x, down.y - middle.y)) / 2;
  const finderPositions = [[3.5, 3.5], [size - 3.5, 3.5], [3.5, size - 3.5]];
  if (measuredFinders && finderPositions.some(([col, row]) => {
    const measured = map(col, row), inferred = result.moduleMap(col, row);
    return Math.hypot(measured.x - inferred.x, measured.y - inferred.y) > halfPitch;
  })) {
    // Three corners contain finders instead of alignment markers. On curled
    // paper the neighboring markers can extrapolate past those visible finders.
    const anchored = grid.slice();
    for (const [col, row] of [[0, 0], [m - 1, 0], [0, m - 1]]) {
      const x = markers[col], y = markers[row];
      const observed = map(x, y), fitted = predicted(aff, x, y);
      anchored[row * m + col] = { dx: observed.x - fitted.x, dy: observed.y - fitted.y };
    }
    result.finderModuleMap = mapWith(anchored);
  }
  return result;
}
