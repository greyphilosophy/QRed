import { expect, it } from "vitest";
import { encodedVersion } from "./qrLowLevel.js";
import { readRectifiedQrVersion } from "./rectifiedQrVersion.js";

function printedVersion(version) {
  const side = 900, size = 17 + 4 * version, pitch = side * 0.92 / size, shear = 0.012;
  const gray = new Uint8Array(side * side).fill(245), encoded = encodedVersion(version);
  const map = (col, row) => ({ x: 30 + pitch * (col + shear * row), y: 32 + pitch * (row + shear * col) });
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const u = (x - 30) / pitch, v = (y - 32) / pitch;
    const col = Math.floor((u - shear * v) / (1 - shear * shear));
    const row = Math.floor((v - shear * u) / (1 - shear * shear));
    let bit = -1;
    if (row >= 0 && row < 6 && col >= size - 11 && col < size - 8) bit = row * 3 + col - size + 11;
    if (col >= 0 && col < 6 && row >= size - 11 && row < size - 8) bit = col * 3 + row - size + 11;
    if (bit >= 0 && (encoded >> bit & 1)) gray[y * side + x] = 210;
  }
  const corners = [map(3.5, 3.5), map(size - 3.5, 3.5), map(3.5, size - 3.5)]
    .map((point, i) => ({ ...point, pitch: pitch * [1.07, 0.96, 1.04][i] }));
  return { gray, side, corners };
}

it.each([17, 27, 31, 40])("reads v%i from corner spacing despite inaccurate local finder pitches", version => {
  const { gray, side, corners } = printedVersion(version);
  expect(readRectifiedQrVersion(gray, side, corners)).toBe(version);
  // Small decoder/quantization changes cannot change the public version.
  gray.forEach((value, i) => { gray[i] = value + (i % 3) - 1; });
  expect(readRectifiedQrVersion(gray, side, corners)).toBe(version);
});

it("requires printed BCH evidence instead of guessing the grid size from the corners", () => {
  const { gray, side, corners } = printedVersion(31);
  gray.fill(245);
  expect(readRectifiedQrVersion(gray, side, corners)).toBeUndefined();
  gray.fill(0);
  expect(readRectifiedQrVersion(gray, side, corners)).toBeUndefined();
});
