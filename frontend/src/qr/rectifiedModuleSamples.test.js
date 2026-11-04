import { expect, it, vi } from "vitest";
import QRCode from "qrcode";
import { createQRedSeals } from "../qredSealer.js";
import { createQRedQrData } from "../qredQr.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { recoverSampledQrMatrix } from "./pageAlignedRecovery.js";
import { collectModuleSamples, classifyModuleSamples, classifyLocalModuleSamples } from "./rectifiedModuleSamples.js";

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

it("measures local ink and paper across a shadow instead of erasing darker watermark ink", () => {
  const size = 45, values = new Uint8Array(size * size * 25);
  const expected = new Uint8Array(size * size);
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    const i = row * size + col;
    expected[i] = Number((col + row) % 2 === 0);
    const paper = 252 - 42 * row / (size - 1), ink = 222 - 62 * row / (size - 1);
    values.fill(Math.round(expected[i] ? ink : paper), i * 25, (i + 1) * 25);
  }
  const original = values.slice();
  const local = classifyLocalModuleSamples({ values, size });
  expect(local.bits).toEqual(expected);
  expect(local.unknown.some(Boolean)).toBe(false);
  const fixed = classifyModuleSamples({ values, size }, 230, 180);
  expect(fixed.bits).not.toEqual(expected);
  expect(fixed.unknown.some(Boolean)).toBe(true);
  expect(values).toEqual(original);
});

it("keeps dark foreground and absent contrast uncertain during local calibration", () => {
  const size = 25, values = new Uint8Array(size * size * 25);
  for (let i = 0; i < size * size; i++) values.fill(i % 2 ? 245 : 200, i * 25, (i + 1) * 25);
  values.fill(25, 12 * size * 25, (12 * size + 4) * 25);
  const local = classifyLocalModuleSamples({ values, size });
  expect(Array.from(local.unknown.slice(12 * size, 12 * size + 4))).toEqual([1, 1, 1, 1]);
  values.fill(245);
  expect(classifyLocalModuleSamples({ values, size }).unknown.every(Boolean)).toBe(true);
  values.fill(0);
  expect(classifyLocalModuleSamples({ values, size }).unknown.every(Boolean)).toBe(true);
});

it("stops local calibration when its cooperative deadline expires", () => {
  const size = 45, values = new Uint8Array(size * size * 25).fill(245);
  const original = values.slice();
  let checks = 0;
  expect(classifyLocalModuleSamples({ values, size }, {
    shouldContinue: () => ++checks < size + 3,
  })).toBeNull();
  expect(checks).toBe(size + 3);
  expect(values).toEqual(original);
});

it("recovers exact signed bytes under varying contrast and still rejects an unrelated key", async () => {
  const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";
  const { seals } = await createQRedSeals({
    privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", publicKey,
    content: "Synthetic local contrast recovery. ".repeat(35), encodingStrategy: "plaintext",
    timestamp: "2026-11-04T12:00:00Z", pageContext: { pageNumber: 1, pageCount: 2, documentRoot: "a1".repeat(32) },
  });
  expect(seals).toHaveLength(1);
  const { payloadBytes } = createQRedQrData(seals[0]);
  const symbol = QRCode.create([{ data: payloadBytes, mode: "byte" }], {
    version: 31, errorCorrectionLevel: "L",
  });
  const size = symbol.modules.size, values = new Uint8Array(size * size * 25);
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    const paper = 252 - 42 * row / (size - 1), ink = 222 - 62 * row / (size - 1);
    const base = symbol.modules.get(row, col) ? ink : paper;
    const covered = row > 10 && row < size - 10 && row % 19 === 0 && col % 4 !== 0;
    for (let sample = 0; sample < 25; sample++) {
      values[(row * size + col) * 25 + sample] = covered && sample < 12
        ? 30 : Math.round(base + (sample % 5) - 2);
    }
  }
  const original = values.slice(), map = (col, row) => ({ x: col, y: row });
  const recover = sampled => recoverSampledQrMatrix(sampled, map, 31,
    { allowSingleBitError: true, allowRankedErasures: false });
  expect(recover(classifyModuleSamples({ values, size }, 230, 180))?.seal).not.toBe(seals[0]);
  const recovered = recover(classifyLocalModuleSamples({ values, size }));
  expect(recovered?.seal).toBe(seals[0]);
  expect(values).toEqual(original);
  await expect(verifyQRedSeals([recovered.seal], publicKey)).resolves.toMatchObject({
    status: "VALID", signature_valid: true, page_number: 1, page_count: 2,
  });
  await expect(verifyQRedSeals([recovered.seal], "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI"))
    .resolves.toMatchObject({ status: "INVALID" });
}, 10000);
