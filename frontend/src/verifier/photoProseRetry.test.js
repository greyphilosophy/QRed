import { expect, it } from "vitest";
import { applyTextRetries, planTextRetries } from "./photoOcrRetry.js";
import { compareLocatedPhotoText } from "./photoTextLayout.js";
import { selectProseReading } from "./photoProseRetry.js";

const size = { width: 800, height: 1200 };
const word = (text, x0, x1, y0, y1, confidence = 95) => ({ text, bbox: { x0, x1, y0, y1 },
  confidence, lineId: y0 < 125 ? "upper" : "lower" });
const line = (text, y0) => ({ text, bbox: { x0: 20, x1: 700, y0, y1: y0 + 29 },
  polygon: [{ x: 20, y: y0 }, { x: 700, y: y0 }, { x: 700, y: y0 + 29 }, { x: 20, y: y0 + 29 }] });
const lines = [line("Your full payment is due today", 87), line("Contact our office on request.", 126)];
const words = [word("Your", 30, 65, 100, 115), word("full", 70, 100, 100, 115),
  word("pt", 110, 180, 98, 145, 24), word("ga", 178, 206, 98, 145, 40),
  word("due", 207, 230, 100, 115), word("today", 240, 275, 100, 115),
  word("Contact", 25, 70, 130, 145), word("our", 75, 95, 130, 145), word("office", 96, 122, 130, 145),
  word("on", 128, 146, 130, 145), word("x", 204, 207, 135, 138, 8)];
// A first-pass engine line can include words on both registered rows.
words[8] = { ...words[8], lineId: words[2].lineId };
const compare = next => compareLocatedPhotoText(lines.map(l => l.text).join("\n"), next, size, lines);
const close = [word("payment", 110, 180, 100, 115), word("is", 184, 205, 100, 115), words[4], words[5],
  { ...words[8], lineId: "lower" }, words[9], word("request.", 174, 209, 130, 145)];

function retry(read) {
  const candidate = planTextRetries(words, compare(words), lines, size).find(c => c.prose);
  expect(candidate).toBeDefined();
  expect(candidate.indices.length).toEqual(new Set(candidate.indices).size);
  const evidence = selectProseReading(words, candidate, read);
  return applyTextRetries(words, evidence ? [{ candidate, words: evidence }] : [], compare);
}

it("reads both prose lines again when weak OCR boxes span the intervening space", () => {
  expect(compare(words).differences.length).toBeGreaterThan(0);
  const result = retry(close);
  expect(compare(result.words).differences).toEqual([]);
  expect(result.retryReviews).toEqual([]);
});

it("retains changed and missing words and an extra word in a two-line rereading", () => {
  for (const [read, expected, observed] of [
    [close.map(w => w.text === "payment" ? { ...w, text: "deposit" } : w), "payment", "deposit"],
    [close.filter(w => w.text !== "is"), "is", ""],
    [[...close, word("also", 149, 168, 130, 145)], "", "also"],
  ]) {
    const result = retry(read);
    expect(result.words.some(w => w.text === "request.")).toBe(true);
    const issues = compare(result.words).differences;
    expect(issues.some(d => d.expected.includes(expected) && d.observed.includes(observed))).toBe(true);
  }
});

it("keeps the first reading if a reread cannot place independent anchors on both lines", () => {
  const result = retry(close.filter(w => w.lineId !== "lower"));
  expect(result.words).toEqual(words);
});

it("includes the entire reliable word when a two-line crop starts partway through its anchor", () => {
  const input = [...words];
  input[6] = word("Contact", 1, 25, 130, 145);
  input[7] = word("our", 29, 57, 130, 145);
  input[8] = word("office", 65, 122, 130, 145);
  const crop = planTextRetries(input, compare(input), lines, size).find(c => c.prose);
  expect(crop.prose[1].anchors).toContain(8);
  expect(crop.bbox.x0).toBeLessThanOrEqual(input[8].bbox.x0);
});

it("checks both lines when a spanning word's center lands on the lower signed row", () => {
  const input = words.map((w, i) => i === 2 || i === 3 ? { ...w, bbox: { ...w.bbox, y1: 154 } } : w);
  const crop = planTextRetries(input, compare(input), lines, size).find(c => c.prose);
  expect(crop).toBeDefined();
  const evidence = selectProseReading(input, crop, close);
  const result = applyTextRetries(input, [{ candidate: crop, words: evidence }], compare);
  expect(compare(result.words).differences).toEqual([]);
});
