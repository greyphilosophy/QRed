import { describe, expect, it } from "vitest";
import { comparePhotoText } from "./photoTextComparison.js";
import { createReviewItems } from "./reviewFindings.js";
import { compareLocatedPhotoText } from "./photoTextLayout.js";

const size = { width: 2000, height: 2000 };
function words(text, confidence = 97) {
  return text.split(/\s+/).filter(Boolean).map((text, i) => ({ text, confidence, bbox: { x0: 10, y0: i * 20, x1: 200, y1: i * 20 + 15 } }));
}

describe("photo comparison against signed text", () => {
  it.each([["Account 123456", "Account123456"], ["Payment due", "Paym entdue"],
    ["Customer", "Custom er"], ["now here", "nowhere"], ["1 000", "1000"]])(
    "keeps word-boundary differences from %s to %s as visible spacing review", (signed, observed) => {
      const result = comparePhotoText(signed, words(observed), size);
      expect(result.status).toBe("uncertain");
      expect(result.differences).toEqual([expect.objectContaining({ spacing: true })]);
      expect(result.differentCount).toBe(0);
    });

  it.each([
    ["The ‘office’", "The 'office'"],
    ["“Approved”", '"Approved"'],
    ["ofﬁce ﬁle", "office file"],
    ["non‑binding", "non-binding"],
    ["Amount −100", "Amount -100"],
  ])("keeps typography-only readings of %s as review items, not confirmed changes or matches", (signed, read) => {
    const result = comparePhotoText(signed, words(read), size);
    expect(result.status).toBe("uncertain");
    expect(result.differences.length).toBeGreaterThan(0);
    expect(result.differences.every(difference => difference.typography)).toBe(true);
    expect(result.uncertainCount).toBeGreaterThan(0);
    expect(result.differentCount).toBe(0);
  });

  it.each([
    ["Pay €100", "Pay $100"], ["Pay 123.45", "Pay 12345"],
    ["Amount −100", "Amount 100"], ["Dose ½", "Dose 1"],
    ["Café", "Cafe"], ["Item ①", "Item 1"], ["Area m²", "Area m2"],
    ["We’re approved", "Were approved"],
  ])("keeps substantive special-character changes from %s to %s prominent", (signed, read) => {
    const result = comparePhotoText(signed, words(read), size);
    expect(result.status).toBe("differences");
    expect(result.differences.some(difference => !difference.typography)).toBe(true);
  });

  it("does not hide a changed number beside a typography mismatch", () => {
    const result = comparePhotoText("‘Pay’ 100", words("'Pay' 900"), size);
    expect(result.status).toBe("differences");
    expect(result.differences.filter(difference => !difference.typography)).toEqual([
      expect.objectContaining({ expected: "100", observed: "900" }),
    ]);
  });
  it.each([["47.85", "42.85"], ["03-17-29", "03-12-29"]])(
    "shows the complete signed and photographed values for a change in %s", (signed, read) => {
      expect(comparePhotoText("Value " + signed, words("Value " + read), size).differences)
        .toEqual([expect.objectContaining({ expected: signed, observed: read })]);
    });
  it("aligns words on the photographed image while ignoring only whitespace and canonical Unicode composition", () => {
    const result = comparePhotoText("Café\nInvoice: 123.45", words("Cafe\u0301 Invoice : 123.45"), size);
    expect(result.status).toBe("matches");
    expect(result.matchedCount).toBe(4);
    expect(result.words[1].bbox).toEqual({ x0: 10, y0: 20, x1: 200, y1: 35 });
  });
  it.each([
    ["Account 123456", "Account 123457"],
    ["Pay $123.45", "Pay $12345"],
    ["Amount -100", "Amount 100"],
    ["Amount (100)", "Amount 100"],
    ["Case ABc", "Case ABC"],
    ["Code O123", "Code 0123"],
    ["Pay A", "Pay \u0410"],
    ["do not pay", "do pay"],
    ["pay twice twice", "pay twice"],
    ["one two", "two one"],
  ])("does not silently accept %s as %s", (expected, observed) => {
    expect(comparePhotoText(expected, words(observed), size).status).toBe("differences");
  });
  it("marks insertions on the image and lists deletions without inventing a location", () => {
    const result = comparePhotoText("Invoice approved", words("Invoice 500 approved"), size);
    expect(result.words.map(word => word.status)).toEqual(["matched", "different", "matched"]);
    expect(result.differences).toEqual([{ expected: "", observed: "500", wordIndices: [1], context: "" }]);
    const deleted = comparePhotoText("Invoice not approved", words("Invoice approved"), size);
    expect(deleted.differences).toEqual([{ expected: "not", observed: "", wordIndices: [],
      referenceStart: 8, context: "Invoice not approved" }]);
  });
  it("uses measured prefix ink only for a missing colon on the same line and within the photo", () => {
    const field = words("Reference 1");
    const dots = { x0: 2, y0: 21, x1: 5, y1: 31 };
    field[1].precedingSeparatorBox = dots;
    expect(comparePhotoText("Reference :1", field, size).differences[0].boxes).toEqual([dots]);
    expect(comparePhotoText("Reference :\n1", field, size).differences[0].boxes).toBeUndefined();
    expect(comparePhotoText("Reference #1", field, size).differences[0].boxes).toBeUndefined();
    expect(comparePhotoText("Reference 1:", field, size).differences[0].boxes).toBeUndefined();
    field[1].precedingSeparatorBox = { ...dots, x0: -1 };
    expect(comparePhotoText("Reference :1", field, size).differences[0].boxes).toBeUndefined();
  });
  it("clears exact located readings at low confidence, including digits and punctuation", () => {
    const result = comparePhotoText("Date : 2017", words("Date : 2017", 36), size);
    expect(result).toMatchObject({ status: "matches", matchedCount: 3, uncertainCount: 0 });
    expect(createReviewItems(result)).toEqual([]);
    const changed = comparePhotoText("Pay : 2017", words("Pay : 2012", 36), size);
    expect(changed.status).toBe("differences");
    expect(changed.words.map(w => w.status)).toEqual(["matched", "matched", "uncertain"]);
    expect(createReviewItems(changed).map(item => item.difference)).toEqual([
      expect.objectContaining({ expected: "2017", observed: "2012" }),
    ]);
  });
  it("clears repeated source OCR strokes only in the corresponding signed prose", () => {
    const signed = "I agree that I am responsible for 2017";
    const sourceReading = "| agree that | am responsible for 2017";
    const box = { x0: 0, y0: 0, x1: 420, y1: 30 };
    const line = { text: signed, bbox: box, polygon: [
      { x: 0, y: 0 }, { x: 420, y: 0 }, { x: 420, y: 30 }, { x: 0, y: 30 },
    ] };
    const read = (photo, source = sourceReading, geometry = line) => {
      const located = words(photo).map((word, i) => ({ ...word, confidence: word.text === "|" ? 46 : 95,
        bbox: { x0: 2 + 45 * i, y0: 5, x1: 2 + 45 * i + (word.text === "|" ? 3 : 25), y1: 23 } }));
      return compareLocatedPhotoText(geometry.text, located, size, [{ ...geometry, sourceReading: source }]);
    };
    expect(createReviewItems(read(sourceReading))).toEqual([]);
    const changed = read("| agree that | am responsible for 2012");
    expect(changed.differences).toEqual([expect.objectContaining({ expected: "2017", observed: "2012" })]);
    expect(read(sourceReading, signed).differences.map(d => d.expected)).toEqual(["I", "I"]);
    expect(read(sourceReading, null).differences.map(d => d.expected)).toEqual(["I", "I"]);
    expect(read("1 agree that | am responsible for 2017").differences[0]).toMatchObject({ expected: "I", observed: "1" });
    expect(read("| agree not | am responsible for 2017").differences.find(d => d.expected === "I")).toBeTruthy();
    expect(read("| 2 3", "| 2 3", { ...line, text: "I 2 3" }).differences).toHaveLength(1);
  });
  it("never declares an empty or unlocated OCR result a match", () => {
    expect(comparePhotoText("Entire missing page", [], size).status).toBe("unreadable");
    expect(comparePhotoText("Text", [{ text: "Text", confidence: 99 }], size).status).toBe("uncertain");
    expect(comparePhotoText("Text", [{ ...words("Text")[0], bbox: { x0: 0, y0: 0, x1: 3000, y1: 10 } }], size).words[0].bbox).toBeNull();
  });
  it("bounds alignment memory for large signed payloads and OCR output", () => {
    expect(() => comparePhotoText("word ".repeat(2100), words("word ".repeat(2100)), size)).toThrow(/too much text/);
    expect(() => comparePhotoText("x".repeat(60001), [], size)).toThrow(/too much text/);
    expect(() => comparePhotoText(" ", [], size)).toThrow(/no text/);
  });
});
