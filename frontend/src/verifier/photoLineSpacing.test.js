import { expect, it } from "vitest";
import { spacePhotoLine } from "./photoLineSpacing.js";

function line(starts) {
  const width = 180, height = 28, data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const left of starts) for (let x = left; x < left + 6; x++) for (let y = 6; y < 22; y++) {
    const pixel = 4 * (y * width + x);
    data.fill(32, pixel, pixel + 3);
  }
  return { width, height, data };
}

it("reduces a field gap while preserving all glyphs and their positions in the original", () => {
  const starts = [8, 16, 110, 122];
  const source = line(starts), spaced = spacePhotoLine(source);
  expect(spaced.width).toBeLessThan(source.width);
  expect([...spaced.sourceX]).toEqual([...spaced.sourceX].sort((a, b) => a - b));
  const dark = [];
  for (let x = 0; x < spaced.width; x++) {
    if (spaced.data[4 * ((spaced.pad + 10) * spaced.width + x)] < 80) dark.push(spaced.sourceX[x]);
  }
  expect(dark).toEqual(starts.flatMap(left => Array.from({ length: 6 }, (_, i) => left + i)));
  expect(spaced.sourceX[spaced.width]).toBe(source.width);
});

it("skips ordinary character spacing, blank crops and oversized crops", () => {
  expect(spacePhotoLine(line([8, 16, 26]))).toBeNull();
  expect(spacePhotoLine(line([]))).toBeNull();
  expect(spacePhotoLine({ width: 2000, height: 400 })).toBeNull();
});
