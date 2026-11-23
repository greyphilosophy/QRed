import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { comparePageReading } from "./photoReading.js";
import { createReviewItems } from "./reviewFindings.js";

const word = (text, x0, y0, x1, y1) => ({ text, confidence: 73, bbox: { x0, y0, x1, y1 } });

function photograph(marks) {
  const canvas = createCanvas(175, 60), ctx = canvas.getContext("2d");
  ctx.fillStyle = "#bcbcbc";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#868686";
  for (const mark of marks) ctx.fillRect(...mark);
  return canvas;
}

function findings(text, words, marks) {
  const result = comparePageReading(text, { words, originalReading: words }, photograph(marks));
  return createReviewItems(result).map(item => item.difference.expected);
}

describe("rereading punctuation in the original photograph", () => {
  const url = "www.sample.org";
  const segments = [word("www", 8, 18, 37, 34), word("sample", 47, 13, 108, 36), word("org", 118, 17, 150, 34)];
  const dot = [40, 31, 3, 3], secondDot = [111, 31, 3, 3];
  it("clears both missed periods when the photograph shows each dot between its neighboring words", () => {
    expect(findings(url, segments, [dot, secondDot])).toEqual([]);
  });
  it("retains only the unresolved URL separator for a blank, comma, colon or elevated speck", () => {
    for (const altered of [[], [[40, 31, 3, 6], [39, 35, 2, 3]], [dot, [40, 20, 3, 3]], [[40, 19, 3, 3]]]) {
      expect(findings(url, segments, [...altered, secondDot])).toEqual(["."]);
    }
  });
  it("reads a faint trailing colon just beyond the last letter of a photographed label", () => {
    const label = word("Customer.", 10, 12, 66, 34), value = word("office", 82, 12, 160, 34);
    const edge = [63, 16, 3, 16], top = [70, 18, 3, 3], bottom = [70, 29, 3, 3];
    const read = (marks, text = label.text) => findings("Customer: office", [{ ...label, text }, value], marks);
    for (const text of ["Customer.", "Customer"]) {
      expect(read([edge, top, bottom], text)).toEqual([]);
      expect(read([edge, bottom], text)).toEqual([":"]);
    }
    for (const changed of [[edge, bottom], [edge, top, [70, 28, 2, 7]],
      [[63, 29, 3, 3], top, bottom], [edge, top, bottom, [76, 30, 3, 3]]]) {
      expect(read(changed)).toEqual([":"]);
    }
  });
  it("resolves a field colon misread as a symbol or omitted beside a recovered page number", () => {
    const number = word("1", 50, 13, 59, 34);
    const colon = word("©", 37, 16, 40, 33);
    const dots = [[37, 16, 3, 3], [37, 30, 3, 3]];
    for (const reading of [[colon, number], [{ ...number, precedingSeparatorBox: colon.bbox }]]) {
      expect(findings(": 1", reading, dots)).toEqual([]);
      for (const changed of [[], dots.slice(1), [[37, 16, 3, 17]], [dots[0], [37, 29, 2, 9]]]) {
        expect(findings(": 1", reading, changed)).toEqual([":"]);
      }
    }
  });
});
