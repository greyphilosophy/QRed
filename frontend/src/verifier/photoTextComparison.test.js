import { describe, expect, it } from "vitest";
import { comparePhotoText } from "./photoTextComparison.js";

const size = { width: 2000, height: 2000 };
function words(text, confidence = 97) {
  return text.split(/\s+/).filter(Boolean).map((text, i) => ({ text, confidence, bbox: { x0: 10, y0: i * 20, x1: 200, y1: i * 20 + 15 } }));
}

describe("photo comparison against signed text", () => {
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
    expect(result.differences).toEqual([{ expected: "", observed: "500", wordIndices: [1] }]);
    const deleted = comparePhotoText("Invoice not approved", words("Invoice approved"), size);
    expect(deleted.differences).toEqual([{ expected: "not", observed: "", wordIndices: [] }]);
  });
  it("keeps low-confidence matches and mismatches uncertain", () => {
    const result = comparePhotoText("Pay 100", words("Pay 100", 45), size);
    expect(result.status).toBe("uncertain");
    expect(result.matchedCount).toBe(0);
    expect(result.uncertainCount).toBe(2);
    const changed = comparePhotoText("Pay 100", words("Pay 900", 45), size);
    expect(changed.status).toBe("differences");
    expect(changed.words[1].status).toBe("uncertain");
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
