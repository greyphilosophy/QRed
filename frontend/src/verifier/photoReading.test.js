import { expect, it } from "vitest";
import { comparePageReading, possiblePrintedMarkings } from "./photoReading.js";

const box = { x0: 100, y0: 200, x1: 160, y1: 260 };
const word = (text, x0, y0, width = 20) => ({ text, confidence: 99, bbox: { x0, y0, x1: x0 + width, y1: y0 + 12 } });
const text = [word("Friday", 10, 10)];
const caption = [word("Verify", 90, 280, 30), word("at", 125, 280, 10), word("qred.org", 140, 280, 40)];
const dimensions = { width: 600, height: 800 };

it("keeps a contrast-assisted agreement uncertain, and still detects changed or added text", () => {
  expect(comparePageReading("Friday", { words: text, contrastAssisted: true }, dimensions).status).toBe("uncertain");
  expect(comparePageReading("Monday", { words: text, contrastAssisted: true }, dimensions).status).toBe("differences");
  expect(comparePageReading("Friday", { words: [...text, word("extra", 10, 50)], contrastAssisted: true }, dimensions).status).toBe("differences");
  expect(comparePageReading("Friday", { words: [], contrastAssisted: true }, dimensions).status).toBe("unreadable");
});
it("separates likely QR markings for visible review without declaring a match", () => {
  const result = comparePageReading("Friday", { words: [...text, word("[=]", 110, 220), ...caption], codes: [box] }, dimensions);
  expect(result.status).toBe("uncertain");
  expect(result.differences).toEqual([]);
  expect(result.markings.map(mark => mark.observed)).toEqual(["[=]", "Verify at qred.org"]);
  expect(result.markings[1].boxes).toHaveLength(3);
});
it("does not globally whitelist a caption, a similar phrase, or additional words", () => {
  expect(possiblePrintedMarkings([...text, ...caption], [])).toEqual([]);
  const elsewhere = caption.map(w => ({ ...w, bbox: { ...w.bbox, y0: 100, y1: 112 } }));
  expect(possiblePrintedMarkings(elsewhere, [box])).toEqual([]);
  const changed = caption.map(w => w.text === "qred.org" ? { ...w, text: "other.org" } : w);
  expect(possiblePrintedMarkings(changed, [box])).toEqual([]);
  const result = comparePageReading("Friday", { words: [...text, ...caption, word("Paid", 190, 280)], codes: [box] }, dimensions);
  expect(result.status).toBe("differences");
  expect(result.differences[0].observed).toBe("Paid");
});
it("keeps signed wording even when it is inside a likely stamp region", () => {
  const result = comparePageReading("Friday Verify at qred.org", { words: [...text, ...caption], codes: [box] }, dimensions);
  expect(result.status).toBe("matches");
  expect(result.markings).toEqual([]);
});
it("shows a possible caption's q/g OCR ambiguity unchanged for manual review", () => {
  const observed = caption.map(w => w.text === "qred.org" ? { ...w, text: "gred.org" } : w);
  const result = comparePageReading("Friday", { words: [...text, ...observed], codes: [box] }, dimensions);
  expect(result.status).toBe("uncertain");
  expect(result.markings[0].observed).toBe("Verify at gred.org");
  expect(comparePageReading("Friday", { words: [...text, ...observed] }, dimensions).status).toBe("differences");
});
it("keeps a footer caption together when only its first word falls inside a large code's padding", () => {
  const largeCode = { x0: 100, y0: 200, x1: 460, y1: 560 };
  const caption = [word("Verify", 480, 350, 30), word("at", 515, 350, 10), word("qred.org", 540, 350, 40)];
  const result = comparePageReading("Friday", { words: [...text, ...caption], codes: [largeCode] }, dimensions);
  expect(result.status).toBe("uncertain");
  expect(result.differences).toEqual([]);
  expect(result.markings.map(mark => mark.observed)).toContain("Verify at qred.org");
});
it("keeps added document words beside a large footer code in the difference list", () => {
  const largeCode = { x0: 100, y0: 200, x1: 460, y1: 560 };
  const result = comparePageReading("Friday", { words: [...text, word("Paid", 485, 300, 35)], codes: [largeCode] }, dimensions);
  expect(result.status).toBe("differences");
  expect(result.differences[0].observed).toBe("Paid");
});
it("keeps an oversized OCR box around QR glyphs visible as a marking", () => {
  const largeCode = { x0: 100, y0: 200, x1: 460, y1: 560 };
  const glyphs = { text: "j= 5 k=l", confidence: 35, bbox: { x0: 80, y0: 195, x1: 475, y1: 280 } };
  const result = comparePageReading("Friday", { words: [...text, glyphs], codes: [largeCode] }, dimensions);
  expect(result.status).toBe("uncertain");
  expect(result.differences).toEqual([]);
  expect(result.markings[0].observed).toBe("j= 5 k=l");
});
