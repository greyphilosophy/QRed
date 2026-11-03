import { expect, it, vi } from "vitest";
import { collectModuleSamples, classifyModuleSamples } from "./rectifiedModuleSamples.js";

it("reads geometry once while threshold retries retain their own ink and erasure decisions", () => {
  const version = 7, size = 45, side = size * 20;
  const gray = new Uint8Array(side * side).fill(245);
  // Three first-row cells: pale ink, darker ink, and completely covered text.
  for (let y = 0; y < 20; y++) for (let x = 0; x < 60; x++)
    gray[y * side + x] = x < 20 ? 225 : x < 40 ? 170 : 25;
  const original = gray.slice();
  const moduleMap = vi.fn((col, row) => ({ x: col * 20, y: row * 20 }));
  const observations = collectModuleSamples(gray, side, side, moduleMap, version);
  expect(moduleMap).toHaveBeenCalledTimes(size * size * 25);
  const broad = classifyModuleSamples(observations, 230, 160);
  const lighter = classifyModuleSamples(observations, 220, 160);
  const textMask = classifyModuleSamples(observations, 230, 180);
  expect(Array.from(broad.bits.slice(0, 4))).toEqual([1, 1, 0, 0]);
  expect(Array.from(lighter.bits.slice(0, 4))).toEqual([0, 1, 0, 0]);
  expect(Array.from(textMask.bits.slice(0, 4))).toEqual([1, 0, 0, 0]);
  expect(Array.from(broad.unknown.slice(0, 4))).toEqual([0, 0, 1, 0]);
  expect(Array.from(textMask.unknown.slice(0, 4))).toEqual([0, 1, 1, 0]);
  expect(Array.from(textMask.confidence.slice(0, 4))).toEqual([0, 30, 30, 0]);
  expect(moduleMap).toHaveBeenCalledTimes(size * size * 25);
  expect(gray).toEqual(original);
});

it("keeps covered, tied and out-of-frame observations as uncertain evidence", () => {
  const values = new Uint8Array(4 * 25).fill(245);
  values.fill(200, 0, 12); // 12 dark / 13 light: ambiguous.
  values.fill(200, 25, 40); // 15 dark / 10 light: sufficient margin.
  values[50] = 25; // One foreground stroke still marks an erasure.
  values.fill(0, 75); // Outside the photo is missing, not recovered ink.
  const sampled = classifyModuleSamples({ values, size: 2 }, 230, 160);
  expect(Array.from(sampled.bits)).toEqual([0, 1, 0, 0]);
  expect(Array.from(sampled.unknown)).toEqual([1, 0, 1, 1]);
  expect(Array.from(sampled.confidence)).toEqual([4, 0, 1, 30]);
  const outside = collectModuleSamples(new Uint8Array([245]), 1, 1, () => ({ x: -1, y: 2 }), 7);
  expect(outside.values.every(value => value === 0)).toBe(true);
});
