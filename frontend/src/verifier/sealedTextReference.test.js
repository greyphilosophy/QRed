import { expect, it } from "vitest";
import { sealedTextReference } from "./sealedTextReference.js";
import { comparePageReading } from "./photoReading.js";
const box = { x: .1, y: .1, width: .5, height: .05 };
const ocrLine = (text, extra = {}) => ({ text, ...box, confidence: 96, ...extra });
const evidence = (text, lines, layout = { mode: 3, lines: [box] }) => ({ text, width: 100, height: 100,
  layout, ocr: { engine: "tesseract-eng-v1", lines } });
const word = text => ({ text, confidence: 99, bbox: { x0: 10, y0: 10, x1: 60, y1: 15 } });

it("uses OCR for an image-only reference without changing native text", () => {
  const record = evidence("", [ocrLine("Friday")], null);
  const reference = sealedTextReference("", record);
  expect(reference.text).toBe("Friday");
  expect(reference.evidence.layout).toEqual({ mode: 3, lines: [record.ocr.lines[0]] });
  expect(record.text).toBe("");
  expect(comparePageReading("", [word("Friday")], { width: 100, height: 100 }, record)).toMatchObject({ status: "uncertain", sealedOcr: true });
  expect(comparePageReading("", [word("Monday")], { width: 100, height: 100 }, record).status).toBe("differences");
});
it("deduplicates only identical overlapping native and OCR lines", () => {
  const record = evidence("Total 100", [ocrLine("Total 100"), ocrLine("Total 100", { y: .7 })]);
  const before = JSON.stringify(record);
  expect(sealedTextReference(record.text, record).text).toBe("Total 100\nTotal 100");
  expect(JSON.stringify(record)).toBe(before);
});
it("does not deduplicate punctuation, digit or whitespace disagreements", () => {
  for (const text of ["Total 100.", "Total 1000", "Total  100"]) {
    const record = evidence("Total 100", [ocrLine(text)]);
    const reference = sealedTextReference(record.text, record);
    expect(reference.text).toBe(`Total 100\n${text}`);
    expect(reference.conflicts).toEqual([{ native: ["Total 100"], ocr: text, confidence: 96 }]);
  }
});
it("retains both readings without exact native line geometry", () => {
  for (const layout of [null, { mode: 1, lines: [box] }, { mode: 2, lines: [box] }]) {
    const record = evidence("Friday", [ocrLine("Friday")], layout);
    expect(sealedTextReference(record.text, record)).toMatchObject({ text: "Friday\nFriday", unresolved: true });
  }
});
it("never reports success for low-confidence, high-confidence or empty sealing OCR", () => {
  for (const lines of [[ocrLine("Friday", { confidence: 1 })], [ocrLine("Friday")], []]) {
    const record = evidence("Friday", lines);
    expect(comparePageReading("Friday", [word("Friday")], { width: 100, height: 100 }, record).status).toBe("uncertain");
  }
});
it("preserves ordinary native-text comparison", () => {
  expect(comparePageReading("Friday", [word("Friday")], { width: 100, height: 100 }).status).toBe("matches");
});
it("bounds spatial reconciliation rather than silently dropping excess readings", () => {
  const lines = Array.from({ length: 513 }, () => ocrLine("Friday"));
  const record = evidence("Friday", lines);
  const reference = sealedTextReference(record.text, record);
  expect(reference.unresolved).toBe(true);
  expect(reference.lines).toHaveLength(514);
});
