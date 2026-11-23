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

it("widens the gaps in a field value and returns the unread separator's original location", () => {
  const source = line([52, 83, 91, 126]);
  for (const y0 of [8, 17]) for (let y = y0; y < y0 + 3; y++) for (let x = 16; x < 19; x++) {
    const pixel = 4 * (y * source.width + x);
    source.data.fill(32, pixel, pixel + 3);
  }
  const result = spacePhotoLine(source, true);
  expect(result.separator).toEqual({ x0: 16, y0: 8, x1: 19, y1: 20 });
  const originalInk = [];
  for (let x = 0; x < result.width; x++) {
    if (result.data[4 * ((result.pad + 10) * result.width + x)] < 80) originalInk.push(result.sourceX[x]);
  }
  expect(originalInk).toEqual([52, 83, 91, 126].flatMap(left => Array.from({ length: 6 }, (_, i) => left + i)));
  // A continuous leading stroke could be a digit. Preserve it for review.
  expect(spacePhotoLine(line([16, 52, 83, 91, 126]), true)).toBeNull();
});
