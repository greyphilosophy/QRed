import { encodedVersion } from "./qrLowLevel.js";

const OFFSETS = [-0.2, 0, 0.2];
const finderDark = (row, col) => row === 0 || col === 0 || row === 6 || col === 6 ||
  (row >= 2 && row <= 4 && col >= 2 && col <= 4);
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

function moduleMedian(gray, side, point, pitch) {
  const values = [];
  for (const dy of OFFSETS) for (const dx of OFFSETS) {
    const x = Math.round(point.x + dx * pitch), y = Math.round(point.y + dy * pitch);
    if (x < 0 || y < 0 || x >= side || y >= side) return null;
    values.push(gray[y * side + x]);
  }
  return median(values);
}

// Use the public finder next to each version field, not document content or
// expected version bits. Local exposure can differ substantially by corner.
function finderThreshold(gray, side, point) {
  const dark = [], light = [];
  for (let row = 0; row < 7; row++) for (let col = 0; col < 7; col++) {
    const value = moduleMedian(gray, side, {
      x: point.x + (col - 3) * point.pitch,
      y: point.y + (row - 3) * point.pitch,
    }, point.pitch);
    if (value !== null && value >= 160) (finderDark(row, col) ? dark : light).push(value);
  }
  if (dark.length < 17 || light.length < 9) return null;
  const ink = median(dark), paper = median(light);
  return paper - ink >= 8 ? (ink + paper) / 2 : null;
}

// Local finder pitch can shift after JPEG decoding by a few percent; also
// measure the grid from the three independently located corners.
function readVersion(gray, side, corners, thresholds = null) {
  const candidates = [], span = side * 0.92;
  const record = (word, version) => {
    let bits = word ^ encodedVersion(version), distance = 0;
    while (bits) { distance++; bits &= bits - 1; }
    if (distance <= 3) candidates.push({ version, distance });
  };
  const read = (map, pitch, threshold = 235) => {
    let word = 0;
    for (let i = 0; i < 18; i++) {
      const p = map(i), x = Math.round(p.x), y = Math.round(p.y);
      if (x < 0 || y < 0 || x >= side || y >= side) return null;
      const value = thresholds ? moduleMedian(gray, side, p, pitch) : gray[y * side + x];
      if (value === null) return null;
      word |= Number(value < threshold) << i;
    }
    return word;
  };
  for (const [index, transpose] of [[1, false], [2, true]]) {
    const p = corners[index];
    if (thresholds && thresholds[index] === null) continue;
    const word = read(i => {
      const a = -7 + i % 3, b = Math.floor(i / 3) - 3;
      return { x: p.x + (transpose ? b : a) * p.pitch,
        y: p.y + (transpose ? a : b) * p.pitch };
    }, p.pitch, thresholds?.[index]);
    if (word === null) continue;
    for (let version = 7; version <= 40; version++) {
      const size = 17 + 4 * version;
      if (Math.abs(size - span / p.pitch) <= size * 0.12) record(word, version);
    }
  }
  const [tl, tr, bl] = corners, estimated = span / ((tr.pitch + bl.pitch) / 2);
  for (let version = 7; version <= 40; version++) {
    const size = 17 + 4 * version;
    if (Math.abs(size - estimated) > size * 0.12) continue;
    for (const transpose of [false, true]) {
      const index = transpose ? 2 : 1;
      if (thresholds && thresholds[index] === null) continue;
      const pitch = (Math.hypot(tr.x - tl.x, tr.y - tl.y) +
        Math.hypot(bl.x - tl.x, bl.y - tl.y)) / (2 * (size - 7));
      const word = read(i => {
        const col = (transpose ? Math.floor(i / 3) : size - 11 + i % 3) + 0.5;
        const row = (transpose ? size - 11 + i % 3 : Math.floor(i / 3)) + 0.5;
        return {
          x: tl.x + (col - 3.5) * (tr.x - tl.x) / (size - 7) + (row - 3.5) * (bl.x - tl.x) / (size - 7),
          y: tl.y + (col - 3.5) * (tr.y - tl.y) / (size - 7) + (row - 3.5) * (bl.y - tl.y) / (size - 7),
        };
      }, pitch, thresholds?.[index]);
      if (word !== null) record(word, version);
    }
  }
  return candidates.sort((a, b) => a.distance - b.distance)[0];
}

// The version is public BCH-protected QR structure, never inferred from the
// document text. A damaged fixed-threshold reading can be within three bits
// of the wrong size. Prefer a closer BCH match from local finder contrast.
export function readRectifiedQrVersion(gray, side, corners) {
  const fixed = readVersion(gray, side, corners);
  if (fixed?.distance === 0) return fixed.version;
  const thresholds = [null, ...corners.slice(1).map(point => finderThreshold(gray, side, point))];
  const local = readVersion(gray, side, corners, thresholds);
  return local && (!fixed || local.distance < fixed.distance) ? local.version : fixed?.version;
}
