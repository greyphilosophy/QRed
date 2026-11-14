import { expect, it } from "vitest";
import { stackRegisteredBurst } from "./registeredBurst.js";

const width = 432, height = 564;
function frame(shiftX, shiftY, seed, reverse = false) {
  const data = new Uint8ClampedArray(width * height * 4);
  let random = seed;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const col = Math.floor((x - shiftX) / 6), row = Math.floor((y - shiftY) / 7);
    let hash = Math.imul(col + 981, 2246822519) ^ Math.imul(row + 139, 1597334677);
    hash = Math.imul(hash ^ (hash >>> 15), 3266489917);
    const shade = ((hash >>> 29) & 1) === Number(reverse) ? 170 : 197;
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const level = shade + (seed ? (random / 4294967296 - .5) * 33 : 0), i = (y * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = level; data[i + 3] = 255;
  }
  return { data, width, height };
}
const first = frame(0, 0, 71), original = first.data.slice();

it("aligns separate exposures before averaging, reducing noise without moving document detail", () => {
  const merged = stackRegisteredBurst(first, [frame(3, -2, 451), frame(-4, 3, 737)]);
  const clean = frame(0, 0, 0);
  const error = img => {
    let loss = 0;
    for (let y = 12; y < height - 12; y++) for (let x = 12; x < width - 12; x++) {
      const i = (y * width + x) * 4; loss += (img.data[i] - clean.data[i]) ** 2;
    }
    return loss;
  };
  expect(merged).not.toBe(first);
  expect(error(merged)).toBeLessThan(.6 * error(first));
  expect(Buffer.compare(Buffer.from(original), Buffer.from(first.data))).toBe(0);
});

it("keeps a single original for repeated frames, different pages and excessive motion", () => {
  expect(stackRegisteredBurst(first, [first, frame(0, 0, 151, true)])).toBe(first);
  expect(stackRegisteredBurst(first, [frame(40, 0, 151)])).toBe(first);
});
