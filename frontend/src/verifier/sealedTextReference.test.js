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
it("keeps punctuation, digit and whitespace disagreements as source review rather than duplicate targets", () => {
  for (const text of ["Total 100.", "Total 1000", "Total  100"]) {
    const record = evidence("Total 100", [ocrLine(text)]);
    const reference = sealedTextReference(record.text, record);
    expect(reference.text).toBe("Total 100");
    expect(reference.unresolved).toBe(true);
    expect(reference.conflicts).toEqual([{ native: ["Total 100"], ocr: text, confidence: 96 }]);
  }
});
it("requires source review without adding duplicate targets when native geometry is absent", () => {
  for (const layout of [null, { mode: 1, lines: [box] }, { mode: 2, lines: [box] }]) {
    const record = evidence("Friday", [ocrLine("Friday")], layout);
    expect(sealedTextReference(record.text, record)).toMatchObject({ text: "Friday", unresolved: true });
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
  expect(reference.lines).toHaveLength(1);
  expect(reference.reviews).toHaveLength(513);
});

it("keeps a combined two-column OCR row out of the required native targets", () => {
  const left = { x: .1, y: .1, width: .25, height: .05 }, right = { x: .7, y: .1, width: .2, height: .05 };
  const record = evidence("Subtotal\n100", [ocrLine("Subtotal 100", { width: .8 })], { mode: 3, lines: [left, right] });
  const before = JSON.stringify(record);
  const reference = sealedTextReference(record.text, record);
  expect(reference.text).toBe("Subtotal\n100");
  expect(reference.conflicts[0]).toMatchObject({ native: ["Subtotal", "100"], ocr: "Subtotal 100" });
  const observed = [{ ...word("Subtotal"), bbox: { x0: 10, y0: 10, x1: 35, y1: 15 } },
    { ...word("100"), bbox: { x0: 70, y0: 10, x1: 90, y1: 15 } }];
  const comparison = comparePageReading(record.text, observed, { width: 100, height: 100 }, record);
  expect(comparison.status).toBe("uncertain");
  expect(comparison.differences).toEqual([]);
  expect(JSON.stringify(record)).toBe(before);
});
it("keeps native punctuation required even when sealing OCR disagrees", () => {
  const record = evidence("Friday.", [ocrLine("Friday")]);
  const matching = comparePageReading(record.text, [word("Friday.")], { width: 100, height: 100 }, record);
  expect(matching.status).toBe("uncertain");
  expect(matching.differences).toEqual([]);
  const changed = comparePageReading(record.text, [word("Friday")], { width: 100, height: 100 }, record);
  expect(changed.differences.length).toBeGreaterThan(0);
});
it("does not let a photo matching conflicting OCR satisfy a changed native target", () => {
  const record = evidence("100", [ocrLine("900")]);
  const comparison = comparePageReading(record.text, [word("900")], { width: 100, height: 100 }, record);
  expect(comparison.status).toBe("differences");
  expect(comparison.differences).toEqual(expect.arrayContaining([expect.objectContaining({ expected: "100", observed: "900" })]));
});
it("retains partial-overlap suffix evidence for review and detects actual extra words", () => {
  const record = evidence("Amount", [ocrLine("Amount 50.00", { width: .8 })]);
  const reference = sealedTextReference(record.text, record);
  expect(reference.text).toBe("Amount");
  expect(reference.unresolved).toBe(true);
  expect(reference.reviews[0].ocr).toBe("Amount 50.00");
  const comparison = comparePageReading(record.text, [word("Amount"),
    { ...word("50.00"), bbox: { x0: 65, y0: 10, x1: 90, y1: 15 } }], { width: 100, height: 100 }, record);
  expect(comparison.status).toBe("differences");
  expect(comparison.differences.some(item => item.observed.includes("50.00"))).toBe(true);
  expect(comparePageReading(record.text, [word("Amount")], { width: 100, height: 100 }, record).status).toBe("uncertain");
});
it("does not merge identical native text printed in separate regions", () => {
  const otherBox = { ...box, y: .7 };
  const record = evidence("Friday\nFriday", [ocrLine("Friday"), ocrLine("Friday", { y: .7 })],
    { mode: 3, lines: [box, otherBox] });
  expect(sealedTextReference(record.text, record).text).toBe("Friday\nFriday");
});
it("treats a giant or multiline OCR box as ambiguous even when text is identical", () => {
  const record = evidence("Friday", [ocrLine("Friday", { y: .05, height: .3 }),
    ocrLine("Second row", { y: .14, height: .06 })]);
  const reference = sealedTextReference(record.text, record);
  expect(reference.text).toBe("Friday");
  expect(reference.conflicts).toHaveLength(2);
  expect(reference.unresolved).toBe(true);
});
it("adds independently located OCR regions while retaining native discrepancies", () => {
  const record = evidence("Friday", [ocrLine("Invoice", { y: .7 })]);
  expect(sealedTextReference(record.text, record).text).toBe("Friday\nInvoice");
  const comparison = comparePageReading(record.text, [word("Monday"),
    { ...word("Invoice"), bbox: { x0: 10, y0: 70, x1: 60, y1: 75 } }], { width: 100, height: 100 }, record);
  expect(comparison.status).toBe("differences");
  expect(comparison.differences.some(item => item.expected.includes("Friday") && item.observed.includes("Monday"))).toBe(true);
});
