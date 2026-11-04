import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { erasureDiscoveryImage } from "./photoScanImage.js";
const digest = data => createHash("sha256").update(data).digest("hex");

it.each([[80_000_000, 1], [1, 80_000_000], [12_500_000, 6]])(
  "interrupts maximum-size thin %s×%s copies within bounded output checkpoints", (width, height) => {
    const image = { width, height, data: new Uint8ClampedArray(width * height * 4).fill(128) };
    const original = digest(image.data); let checks = 0;
    expect(erasureDiscoveryImage(image, { shouldContinue: () => ++checks < 5 })).toBeNull();
    expect(checks).toBe(5);
    expect(digest(image.data)).toBe(original);
  });

it("respects a typed-array byte offset without touching adjacent memory", () => {
  const bytes = new Uint8ClampedArray(4_000_000 * 4 + 32).fill(19);
  const view = bytes.subarray(16, bytes.length - 16); view.fill(128);
  const image = { width: 2000, height: 2000, data: view }, before = digest(bytes);
  const result = erasureDiscoveryImage(image);
  expect(result.data[0]).toBe(128); expect(result.data.at(-1)).toBe(128);
  expect(digest(bytes)).toBe(before);
});
