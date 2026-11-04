import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { erasureDiscoveryImage, validatePhotoImage } from "./photoScanImage.js";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const image = (width, height, color = [45, 121, 230, 255]) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let at = 0; at < data.length; at += 4) data.set(color, at);
  return { data, width, height };
};

it("reuses images within the existing three-megapixel discovery cap", () => {
  const original = image(1500, 2000), before = hash(original.data);
  expect(erasureDiscoveryImage(original)).toBe(original);
  expect(hash(original.data)).toBe(before);
});

it("area averages a separate bounded copy without altering original bytes or metadata", () => {
  const original = { ...image(2000, 2000, [0, 0, 0, 128]), bounds: { x: 2, y: 3 }, scale: 4 };
  // Vertical white stripes have fractional coverage at the output scale.
  for (let y = 0; y < original.height; y++) for (let x = 1; x < original.width; x += 2) {
    const at = (y * original.width + x) * 4;
    original.data[at] = 255; original.data[at + 1] = 102; original.data[at + 2] = 51;
  }
  const before = hash(original.data), discovery = erasureDiscoveryImage(original);
  expect([discovery.width, discovery.height]).toEqual([1414, 1414]);
  expect(discovery.width * discovery.height).toBeLessThanOrEqual(2_000_000);
  expect(discovery.data.buffer).not.toBe(original.data.buffer);
  expect(discovery).not.toHaveProperty("bounds"); expect(discovery).not.toHaveProperty("scale");
  const coverage = 1 - discovery.width / original.width;
  expect([...discovery.data.slice(0, 4)]).toEqual([Math.round(255 * coverage), Math.round(102 * coverage), Math.round(51 * coverage), 128]);
  expect(hash(original.data)).toBe(before);
  expect(original.bounds).toEqual({ x: 2, y: 3 }); expect(original.scale).toBe(4);
});

it.each([[3_000_001, 1], [1, 3_000_001]])("keeps a very thin %s×%s discovery image within the allocation cap", (width, height) => {
  const original = image(width, height), discovery = erasureDiscoveryImage(original);
  expect(discovery.width * discovery.height).toBe(2_000_000);
  expect([...discovery.data.slice(-4)]).toEqual([45, 121, 230, 255]);
});

it("discards an incomplete copy when its cooperative budget expires", () => {
  const original = image(2000, 2000), before = hash(original.data);
  let checks = 0;
  expect(erasureDiscoveryImage(original, { shouldContinue: () => ++checks < 8 })).toBeNull();
  expect(checks).toBe(8); expect(hash(original.data)).toBe(before);
});

it("rejects cancellation before and during copy work", () => {
  const original = image(2000, 2000), controller = new AbortController();
  let checks = 0;
  expect(() => erasureDiscoveryImage(original, { signal: controller.signal,
    shouldContinue: () => { if (++checks === 8) controller.abort(); return true; } })).toThrow();
  expect(() => erasureDiscoveryImage(original, { signal: controller.signal })).toThrow();
});

it.each([null, {}, { width: Infinity, height: 1 }, { width: -1, height: 1 },
  { width: 1.5, height: 1 }, { width: 80_000_001, height: 1, data: { length: 320_000_004 } },
  { width: 1, height: 1, data: { length: 4 } }, { width: 1, height: 1, data: new Float32Array(4) },
  { width: 1, height: 1, data: new Uint8Array(3) }])("rejects malformed image %j before allocating a copy", original => {
  expect(() => validatePhotoImage(original)).toThrow(/smaller photo/);
  expect(() => erasureDiscoveryImage(original)).toThrow(/smaller photo/);
});
