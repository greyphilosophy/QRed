// Fit a smooth surface through alignment marks observed on the same printed
// QR. A cubic radial basis with an affine tail handles irregularly spaced
// marks without a discontinuity where adjacent grid cells meet.
import { solveLinearSystem } from "./linearSystem.js";

// A real bend can move neighboring marks beyond the global affine tolerance.
// Keep a displaced mark only when its offset continues a pair already measured
// along its row or column. Repeat from the accepted marks in every direction.
export function supportedBendAnchors(points, centers, inliers, predict, finderMap, tolerance) {
  const m = centers.length, supported = inliers.slice();
  const remaining = points.filter(p => !supported[p.ri * m + p.ci] && p.score >= .8);
  function follows(p, dx, dy, dr, dc) {
    const r = p.ri + dr, c = p.ci + dc, rr = r + dr, cc = c + dc;
    if (rr < 0 || rr >= m || cc < 0 || cc >= m) return false;
    const near = supported[r * m + c], far = supported[rr * m + cc];
    if (!near || !far) return false;
    const spacing = dr ? (centers[p.ri] - centers[r]) / (centers[r] - centers[rr])
      : (centers[p.ci] - centers[c]) / (centers[c] - centers[cc]);
    return Math.hypot(dx - near.dx - spacing * (near.dx - far.dx),
      dy - near.dy - spacing * (near.dy - far.dy)) < tolerance;
  }
  let accepted = 0, previous;
  do {
    previous = accepted;
    for (const p of remaining) {
      const at = p.ri * m + p.ci;
      if (supported[at]) continue;
      const base = predict(p), dx = p.x - base.x, dy = p.y - base.y;
      if (follows(p, dx, dy, -1, 0) || follows(p, dx, dy, 1, 0)
        || follows(p, dx, dy, 0, -1) || follows(p, dx, dy, 0, 1)) {
        supported[at] = { dx, dy };
        accepted++;
      }
    }
  } while (previous !== accepted);
  if (!accepted) return null;
  const anchors = points.filter(p => supported[p.ri * m + p.ci]);
  // Three corners contain a finder in place of an alignment mark. Extend
  // its observed axes to the same coordinate used by the finder-anchored grid.
  for (const [ci, ri] of [[0, 0], [m - 1, 0], [0, m - 1]]) {
    const col = centers[ci] + .5, row = centers[ri] + .5;
    anchors.push({ col, row, ...finderMap(col, row) });
  }
  return anchors;
}

function cubicDistance(x, y) {
  const squared = x * x + y * y;
  return squared * Math.sqrt(squared);
}

export function bentModuleGrid(anchors, toPhoto, size, shouldContinue) {
  if (!shouldContinue()) return null;
  const n = anchors.length;
  const matrix = Array.from({ length: n + 3 }, () => new Float64Array(n + 3));
  const x = new Float64Array(n + 3), y = new Float64Array(n + 3);
  for (let i = 0; i < n; i++) {
    const a = anchors[i], native = toPhoto(a.x, a.y);
    x[i] = native.x; y[i] = native.y;
    for (let j = 0; j < i; j++) {
      matrix[i][j] = matrix[j][i] = cubicDistance(a.col - anchors[j].col, a.row - anchors[j].row);
    }
    matrix[i][n] = matrix[n][i] = 1;
    matrix[i][n + 1] = matrix[n + 1][i] = a.col;
    matrix[i][n + 2] = matrix[n + 2][i] = a.row;
  }
  const wx = solveLinearSystem(matrix, x), wy = solveLinearSystem(matrix, y);
  if (!wx || !wy) return null;
  // Fit at module corners once, then interpolate the interior photo samples.
  const stride = size + 1, xs = new Float32Array(stride * stride), ys = new Float32Array(xs.length);
  for (let row = 0; row <= size; row++) {
    if (!shouldContinue()) return null;
    for (let col = 0; col <= size; col++) {
      let px = wx[n] + wx[n + 1] * col + wx[n + 2] * row;
      let py = wy[n] + wy[n + 1] * col + wy[n + 2] * row;
      for (let i = 0; i < n; i++) {
        const weight = cubicDistance(col - anchors[i].col, row - anchors[i].row);
        px += weight * wx[i]; py += weight * wy[i];
      }
      xs[row * stride + col] = px; ys[row * stride + col] = py;
    }
  }
  return (col, row) => {
    const left = Math.min(size - 1, Math.floor(col)), top = Math.min(size - 1, Math.floor(row));
    const at = top * stride + left, u = col - left, v = row - top;
    const interpolate = values => (1 - v) * ((1 - u) * values[at] + u * values[at + 1])
      + v * ((1 - u) * values[at + stride] + u * values[at + stride + 1]);
    return { x: interpolate(xs), y: interpolate(ys) };
  };
}
