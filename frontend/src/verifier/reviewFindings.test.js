import { expect, it } from "vitest";
import { changedCharacters, createReviewItems, currentReview, reviewCounts, sealedPassage } from "./reviewFindings.js";

const box = { x0: 10, y0: 20, x1: 80, y1: 40 };
const comparison = overrides => ({ differences: [], words: [], ...overrides });

it("keeps faint additions, low-confidence matches and spacing in the review queue", () => {
  const result = comparison({ differences: [
    { expected: "now here", observed: "nowhere", spacing: true, wordIndices: [0] },
    { expected: "2027", observed: "2022", wordIndices: [1] },
  ], words: [{ sourceIndex: 0, bbox: box, status: "uncertain" },
    { sourceIndex: 1, bbox: box, status: "different" },
    { sourceIndex: 2, text: "Approved", bbox: box, status: "uncertain", agrees: true }],
  originalComparison: comparison({ differences: [{ expected: "", observed: "Paid", boxes: [{ ...box, y0: 60, y1: 80 }] }] }),
  contrastAssisted: true });
  const items = createReviewItems(result);
  expect(items).toHaveLength(5);
  expect(items[0].difference.expected).toBe("2027");
  expect(items.map(item => item.difference.observed)).toContain("Paid");
  expect(items.map(item => item.reason)).toContain("Word spacing");
  expect(items.find(item => item.difference.observed === "Approved").inspection).toBe(false);
  expect(items.at(-1).reason).toBe("Pale text and marks");
  expect(reviewCounts(items, { [items[0].id]: "unsure" })).toMatchObject({ reviewed: 1, pending: 4, unsure: 1 });
});

it("shares duplicate locations while retaining the conflicting reread evidence", () => {
  const difference = { expected: "03-14-27", observed: "03-14-29", boxes: [box] };
  const result = comparison({ differences: [difference], originalComparison: comparison({ differences: [difference] }),
    retryReviews: [{ dateField: true, signedDate: difference.expected, original: difference.observed,
      observed: difference.expected, boxes: [box] }] });
  const items = createReviewItems(result);
  expect(items).toHaveLength(1);
  expect(items[0].readings.map(reading => reading.text)).toEqual(["03-14-29", "03-14-27"]);
  expect(items[0].notes.join(" ")).toContain("first reading");
  expect(result.differences[0]).toEqual(difference);
});

it("shares missing punctuation across passes only at the same signed position", () => {
  const missing = { expected: ":", observed: "", wordIndices: [], context: "A : B :", referenceStart: 2 };
  const differences = [missing, { ...missing, referenceStart: 6 }, { ...missing, context: "C : D" }];
  for (const boxes of [[], [box]]) {
    const findings = differences.map(d => ({ ...d, boxes }));
    const result = comparison({ differences: findings, originalComparison: comparison({ differences: findings }) });
    expect(createReviewItems(result).map(item => item.difference)).toEqual(findings);
  }
  const unlocated = { expected: ":", observed: "", wordIndices: [] };
  expect(createReviewItems(comparison({ differences: [unlocated, unlocated] }))).toHaveLength(2);
});

it("does not merge equal wording at different locations or invent a signed reference", () => {
  const items = createReviewItems(comparison({ differences: [
    { expected: "12", observed: "72", boxes: [box] },
    { expected: "12", observed: "72", boxes: [{ ...box, y0: 80, y1: 100 }] },
  ], retryReviews: [{ original: "Tota", observed: "Total", boxes: [box] }] }));
  expect(items).toHaveLength(3);
  expect(items[2].inspection).toBe(true);
  expect(items[2].difference.expected).toBeUndefined();
});

it("invalidates observations after a new capture, reference, or text-reading result", () => {
  const page = { captureId: "a", reference: "signed-a", comparison: comparison({}) };
  const saved = { ...page, index: 2, decisions: { first: "matches" } };
  expect(currentReview(saved, page)).toBe(saved);
  for (const change of [{ captureId: "b" }, { reference: "signed-b" }, { comparison: comparison({}) }, { comparison: null }])
    expect(currentReview(saved, { ...page, ...change })).toEqual({ index: 0, decisions: {} });
});

it.each([["PARK", "PARE", "K", "E"], ["2027", "2022", "7", "2"],
  ["123.45", "923.45", "1", "9"], ["now here", "nowhere", " ", ""], ["A😀B", "A😃B", "😀", "😃"]])(
  "highlights the actual changed characters in %s and %s", (expected, observed, removed, added) => {
    const parts = changedCharacters(expected, observed);
    expect(parts.expected.filter(p => p.changed).map(p => p.text).join("")).toBe(removed);
    expect(parts.observed.filter(p => p.changed).map(p => p.text).join("")).toBe(added);
    expect(parts.expected.map(p => p.text).join("")).toBe(expected);
    expect(parts.observed.map(p => p.text).join("")).toBe(observed);
  });

it("bounds work for long OCR fragments and preserves all original characters", () => {
  const prefix = "a".repeat(1000), suffix = "b".repeat(1000);
  const parts = changedCharacters(prefix + "7" + suffix, prefix + "2" + suffix);
  expect(parts.expected).toEqual([{ text: prefix, changed: false }, { text: "7", changed: true }, { text: suffix, changed: false }]);
});

it("shows the complete sealed line while keeping the disputed characters separate", () => {
  const source = "Invoice 1042\nApproved total 123.45\nPayment due Friday";
  expect(sealedPassage({ expected: "123.45", observed: "923.45", context: source }, source))
    .toEqual({ before: "Approved total ", expected: "123.45", after: "" });
  const longLine = "Original wording ".repeat(12) + "123.45" + " with exact punctuation!";
  expect(sealedPassage({ expected: "123.45", context: longLine.slice(-90) }, longLine))
    .toEqual({ before: "Original wording ".repeat(12), expected: "123.45", after: " with exact punctuation!" });
});

it("uses the supplied sealed context to distinguish repeated values", () => {
  const source = "First amount 100\nSecond amount 100 due";
  expect(sealedPassage({ expected: "100", context: "Second amount 100 due" }, source))
    .toEqual({ before: "Second amount ", expected: "100", after: " due" });
  expect(sealedPassage({ expected: "100", context: source }, source))
    .toEqual({ before: "", expected: "100", after: "" });
  expect(sealedPassage({ expected: "100" }, source))
    .toEqual({ before: "", expected: "100", after: "" });
});

it("does not invent sealed wording from an extra reading or a partial token", () => {
  expect(sealedPassage({ expected: "", observed: "Paid" }, "Approved total 123.45"))
    .toEqual({ before: "", expected: "", after: "" });
  expect(sealedPassage({ expected: "1" }, "Invoice 1042"))
    .toEqual({ before: "", expected: "1", after: "" });
  expect(sealedPassage({ expected: "Friday", observed: "Monday" }, "Friday"))
    .toEqual({ before: "", expected: "Friday", after: "" });
});
