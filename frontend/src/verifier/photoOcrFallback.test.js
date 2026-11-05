import { expect, it } from "vitest";
import { needsPageReread, pageReadingCanvas, preferPageReread } from "./photoOcrFallback.js";

const words = (text, confidence) => text.split(" ").map(text => ({ text, confidence }));
it("retries a noisy reading but leaves a clear page on its fast path", () => {
  expect(needsPageReread(words("Invoice total payable by next Friday", 50))).toBe(true);
  expect(needsPageReread(words("Invoice total payable by next Friday", 96))).toBe(false);
  expect(needsPageReread(words("Friday", 40))).toBe(false);
});
it("selects a better independent reading, including a genuinely changed amount", () => {
  const before = words("Invoice t0ta1 payable by next Fr1day 100.00", 50);
  expect(preferPageReread(before, words("Invoice total payable by next Friday 900.00", 96))).toBe(true);
  expect(preferPageReread(before, words("Friday", 99))).toBe(false);
  expect(preferPageReread(words("Invoice total payable by next Friday", 96), before)).toBe(false);
  expect(preferPageReread(before, words("Invoice total payable by next Friday", NaN))).toBe(false);
});
it("refuses absent, clipped, reversed or implausibly small paper boundaries", () => {
  const size = { width: 1000, height: 1400 };
  const corners = [{x:10,y:10},{x:990,y:10},{x:990,y:1390},{x:10,y:1390}];
  for (const invalid of [null, corners.slice(1), [...corners].reverse(),
    corners.map(p => ({x:p.x/10,y:p.y/10})), corners.map(p => ({...p,x:p.x+100}))])
    expect(pageReadingCanvas(size, invalid)).toBeNull();
});
