import { encodedVersion } from "./qrLowLevel.js";

// The version is public BCH-protected QR structure, never inferred from the
// document text. Local finder pitch can shift after JPEG decoding by a few
// percent; also measure the grid from the three independently located corners.
export function readRectifiedQrVersion(gray, side, corners) {
  const candidates = [], span = side * 0.92;
  const record = (word, version) => {
    let bits = word ^ encodedVersion(version), distance = 0;
    while (bits) { distance++; bits &= bits - 1; }
    if (distance <= 3) candidates.push({ version, distance });
  };
  const read = map => {
    let word = 0;
    for (let i = 0; i < 18; i++) {
      const p = map(i), x = Math.round(p.x), y = Math.round(p.y);
      if (x < 0 || y < 0 || x >= side || y >= side) return null;
      word |= Number(gray[y * side + x] < 235) << i;
    }
    return word;
  };
  for (const [index, transpose] of [[1, false], [2, true]]) {
    const p = corners[index];
    const word = read(i => {
      const a = -7 + i % 3, b = Math.floor(i / 3) - 3;
      return { x: p.x + (transpose ? b : a) * p.pitch,
        y: p.y + (transpose ? a : b) * p.pitch };
    });
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
      const word = read(i => {
        const col = (transpose ? Math.floor(i / 3) : size - 11 + i % 3) + 0.5;
        const row = (transpose ? size - 11 + i % 3 : Math.floor(i / 3)) + 0.5;
        return {
          x: tl.x + (col - 3.5) * (tr.x - tl.x) / (size - 7) + (row - 3.5) * (bl.x - tl.x) / (size - 7),
          y: tl.y + (col - 3.5) * (tr.y - tl.y) / (size - 7) + (row - 3.5) * (bl.y - tl.y) / (size - 7),
        };
      });
      if (word !== null) record(word, version);
    }
  }
  return candidates.sort((a, b) => a.distance - b.distance)[0]?.version;
}
