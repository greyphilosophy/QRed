import { expect, it } from "vitest";
import { comparePageReading } from "./photoReading.js";

const dimensions = { width: 1000, height: 1000 };
const box = (y, x = .1) => ({ x, y, width: .5, height: .04 });
function fixture(native = "1 of 2", baseline = "1of2", observed = baseline) {
  const texts = ["Distinctive top anchor", "Independent middle anchor", native, "Distinctive bottom anchor"];
  const boxes = [.1, .4, .6, .85].map(y => box(y));
  const evidence = { text: texts.join("\n"), width: 1000, height: 1000,
    layout: { mode: 3, lines: boxes }, ocr: { engine: "tesseract-eng-v1", lines: texts.map((text, i) => ({
      text: i === 2 ? baseline : text, ...boxes[i], confidence: 96 })) } };
  const words = texts.map((text, i) => ({ text: i === 2 ? observed : text, lineId: i, confidence: 99,
    bbox: { x0: 100, y0: boxes[i].y * 1000, x1: 600, y1: (boxes[i].y + boxes[i].height) * 1000 } }));
  return { evidence, words };
}
const compare = ({ evidence, words }, extra = {}) => comparePageReading(evidence.text, { words, ...extra }, dimensions, evidence);
const reading = result => result.ocrBaseline.readings[2];

it("locates the same original spacing discrepancy without rewriting either source or differences", () => {
  const input = fixture(), saved = JSON.stringify(input);
  const result = compare(input);
  expect(reading(result)).toMatchObject({ status: "repeated", native: ["1 of 2"], baseline: "1of2", observed: "1of2", sourceDiscrepancy: true });
  expect(result.differences).toEqual(expect.arrayContaining([expect.objectContaining({ expected: "1 of 2", observed: "1of2", spacing: true })]));
  expect(result.status).not.toBe("matches");
  expect(JSON.stringify(input)).toBe(saved);
});
it("does not excuse a real numeric change that happens to equal the original OCR error", () => {
  const result = compare(fixture("100", "900", "900"));
  expect(reading(result).status).toBe("repeated");
  expect(result.status).toBe("differences");
  expect(result.differences).toEqual(expect.arrayContaining([expect.objectContaining({ expected: "100", observed: "900" })]));
});
it.each(["800", "900.", "9 00", "900 extra", "9000"])("retains newly different reading %s", observed => {
  const result = compare(fixture("100", "900", observed));
  expect(reading(result).status).toBe("different");
  expect(result.status).toBe("differences");
});
it("preserves the conflict when the new OCR agrees with native text", () => {
  const result = compare(fixture("100", "900", "100"));
  expect(reading(result)).toMatchObject({ status: "different", observed: "100" });
  expect(result.status).toBe("uncertain");
  expect(result.referenceConflicts).toHaveLength(1);
});
it("does not match identical text elsewhere or missing text", () => {
  for (const missing of [false, true]) {
    const input = fixture("100", "900");
    if (missing) input.words.splice(2, 1);
    else input.words[2].bbox = { x0: 650, y0: 600, x1: 950, y1: 640 };
    const result = compare(input);
    expect(reading(result).status).toBe("unreadable");
    expect(result.status).toBe("differences");
  }
});
it("retains added words outside a repeated baseline region", () => {
  const input = fixture("100", "900");
  input.words.push({ text: "Paid", confidence: 99, lineId: 10, bbox: { x0: 700, y0: 700, x1: 800, y1: 740 } });
  const result = compare(input);
  expect(reading(result).status).toBe("repeated");
  expect(result.differences.some(item => item.observed === "Paid")).toBe(true);
  expect(result.status).toBe("differences");
});
it("requires independent native registration, not baseline strings alone", () => {
  const input = fixture();
  input.words = input.words.filter((_, index) => index === 2);
  expect(compare(input).ocrBaseline).toEqual({ located: false, readings: [] });
  input.evidence.layout = null;
  expect(compare(input).ocrBaseline.located).toBe(false);
});
it("rejects duplicate and overlapping baseline regions", () => {
  const input = fixture();
  input.evidence.ocr.lines.push({ ...input.evidence.ocr.lines[2] });
  const result = compare(input);
  expect(reading(result).status).toBe("ambiguous");
  expect(result.ocrBaseline.readings.at(-1).status).toBe("ambiguous");
});
it("rejects multi-column or partial native correspondence", () => {
  for (const width of [.2, .9]) {
    const input = fixture();
    input.evidence.ocr.lines[2].width = width;
    if (width === .9) {
      input.evidence.text += "\nSecond column";
      input.evidence.layout.lines.push({ ...box(.6, .7), width: .2 });
    }
    expect(reading(compare(input)).status).not.toBe("repeated");
  }
});
it("keeps weak readings, retry conflicts and contrast warnings even when the baseline repeats", () => {
  const input = fixture("100", "900");
  input.words[2].confidence = 1;
  input.evidence.ocr.lines[2].confidence = 1;
  const result = compare(input, { contrastAssisted: true, retryReviews: [{ original: "800", observed: "900" }] });
  expect(reading(result)).toMatchObject({ status: "repeated", confidence: 1 });
  expect(result.uncertainCount).toBeGreaterThan(0);
  expect(result.contrastAssisted).toBe(true);
  expect(result.retryReviews).toHaveLength(1);
  expect(result.status).toBe("differences");
});
it("bounds baseline work and rejects invalid geometry", () => {
  const input = fixture();
  input.evidence.ocr.lines[2].x = -1;
  expect(compare(input).ocrBaseline.located).toBe(false);
  input.evidence.ocr.lines = Array.from({ length: 513 }, () => ({ ...box(.6), text: "1of2", confidence: 90 }));
  expect(compare(input).ocrBaseline).toEqual({ located: false, readings: [] });
});

it("does not call a giant observed word box a located repeated reading", () => {
  const input = fixture("100", "900");
  input.words[2].bbox = { x0: 0, y0: 500, x1: 1000, y1: 740 };
  expect(reading(compare(input)).status).toBe("ambiguous");
});
