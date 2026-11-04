import { expect, it } from "vitest";
import { applyTextRetries, MAX_TEXT_RETRIES, planTextRetries, preferTextRetry } from "./photoOcrRetry.js";
import { comparePageReading } from "./photoReading.js";
import { compareLocatedPhotoText } from "./photoTextLayout.js";

const size = { width: 1000, height: 1400 };
const word = (text, confidence = 60, y = 100, x = 20) => ({ text, confidence, lineId: `line-${y}`,
  bbox: { x0: x, y0: y, x1: x + 100, y1: y + 25 } });
const candidate = { indices: [0], bbox: { x0: 10, y0: 90, x1: 140, y1: 140 } };

it("rereads a questionable line once, preserving original-image coordinates", () => {
  const words = [word("Pay"), word("123.45", 60, 100, 150), word("Friday", 98, 200)];
  const result = planTextRetries(words, comparePageReading("Pay 123.45 Friday", { words }, size), null, size);
  expect(result).toHaveLength(1);
  expect(result[0].indices).toEqual([0, 1]);
  expect(result[0].bbox.x0).toBeLessThan(20);
  expect(result[0].bbox.x1).toBeGreaterThan(250);
});

it("bounds the number of automatic crops on a noisy page", () => {
  const words = Array.from({ length: 30 }, (_, i) => word("unreadable", 30, i * 40));
  const comparison = comparePageReading("Expected text", { words }, size);
  expect(planTextRetries(words, comparison, null, size)).toHaveLength(MAX_TEXT_RETRIES);
});

it("retries partially missing signed lines even when every word that was read agrees", () => {
  const words = [word("Room", 98)];
  const lines = [{ text: "Room 125.50", bbox: { x0: 10, y0: 90, x1: 500, y1: 140 },
    polygon: [{x:10,y:90},{x:500,y:90},{x:500,y:140},{x:10,y:140}] }];
  const comparison = compareLocatedPhotoText("Room 125.50", words, size, lines);
  expect(comparison.words[0].status).toBe("matched");
  const plans = planTextRetries(words, comparison, lines, size);
  expect(plans).toHaveLength(1);
  expect(plans[0].indices).toEqual([0]);
  expect(plans[0].bbox.x1).toBeGreaterThan(500);
});

it("does not prefer a reading for agreement with the signed text or discard faint additions silently", () => {
  expect(preferTextRetry([word("900", 96)], [word("100", 95)])).toBe(false);
  const merged = applyTextRetries([word("Do not pay", 60)], [{ candidate, words: [word("Do pay", 97)] }]);
  expect(merged.words[0].text).toBe("Do pay");
  expect(merged.retryReviews).toEqual([expect.objectContaining({ original: "Do not pay", observed: "Do pay" })]);
  expect(comparePageReading("Do pay", merged, size).status).toBe("uncertain");
  expect(comparePageReading("Do not pay", merged, size).status).toBe("differences");
});

it("keeps changed amounts and signs as content differences after a better independent reading", () => {
  for (const [signed, observed] of [["123.45", "923.45"], ["-100.00", "100.00"], ["123.45", "12345"]]) {
    const merged = applyTextRetries([word("?", 10)], [{ candidate, words: [word(observed, 97)] }]);
    expect(comparePageReading(signed, merged, size).status).toBe("differences");
  }
});

it("preserves unrelated words and rejects empty or substantially incomplete retry readings", () => {
  const original = [word("Payment", 50), word("Paid", 98, 300)];
  const merged = applyTextRetries(original, [{ candidate, words: [word("Payment", 98)] }]);
  expect(merged.words.map(w => w.text)).toEqual(["Payment", "Paid"]);
  expect(merged.retryReviews).toEqual([]);
  expect(preferTextRetry(original, [])).toBe(false);
  expect(preferTextRetry([word("Do not pay", 40)], [word("Do", 99)])).toBe(false);
});

it("can recover an omitted column even when the first pass was confident about its row label", () => {
  const merged = applyTextRetries([word("Room", 98)], [{ candidate,
    words: [word("Room", 96), word("125.50", 96, 100, 150)] }]);
  expect(merged.words.map(w => w.text)).toEqual(["Room", "125.50"]);
  expect(merged.retryReviews[0]).toMatchObject({ original: "Room", observed: "Room 125.50" });
  expect(comparePageReading("Room 125.50", merged, size).status).toBe("uncertain");
  expect(preferTextRetry([word("Room", 98)], [word("Room extra", 70)])).toBe(false);
});


it("trims retry padding before it clips the edge of the next line", () => {
  const words = [word("Total", 50), word("Following", 98, 127)];
  const comparison = comparePageReading("Total Following", { words }, size);
  const plans = planTextRetries(words, comparison, null, size);
  expect(plans).toHaveLength(1);
  expect(plans[0].indices).toEqual([0]);
  expect(plans[0].bbox.y1).toBe(127);
});

it("rejects a crop that clips a neighboring word even if its center is outside", () => {
  const words = [word("Total", 50), word("Neighbor", 98, 124, 80)];
  const comparison = comparePageReading("Total Neighbor", { words }, size);
  expect(planTextRetries(words, comparison, null, size)).toEqual([]);
});

it("does not let a confident row hide a newly hallucinated low-confidence token", () => {
  const before = [word("Service", 94), word("charge", 94), word("24.00", 94)];
  expect(preferTextRetry(before, [...before, word("~~", 40)])).toBe(false);
  expect(preferTextRetry(before.map(w => ({ ...w, confidence: 85 })),
    [...before, word("~", 40)])).toBe(false);
  const merged = applyTextRetries(before, [{ candidate: { ...candidate, indices: [0, 1, 2] },
    words: [...before, word("~", 40)] }]);
  expect(merged.words).toEqual(before);
  expect(merged.retryReviews).toEqual([]);
});

it("does not skip adjacent missing punctuation when only blank retry padding overlaps", () => {
  const words = [word("First", 96, 100), word("Second", 96, 134)];
  const lines = [90, 131].map((y, i) => ({ text: `${i ? "Second" : "First"} :`,
    bbox: { x0: 10, y0: y, x1: 500, y1: y + 40 },
    polygon: [{ x: 10, y }, { x: 500, y }, { x: 500, y: y + 40 }, { x: 10, y: y + 40 }] }));
  const comparison = compareLocatedPhotoText("First :\nSecond :", words, size, lines);
  const plans = planTextRetries(words, comparison, lines, size);
  expect(plans).toHaveLength(2);
  expect(plans[0].indices).toEqual([0]);
  expect(plans[1].indices).toEqual([1]);
  expect(plans[0].bbox.y1).toBeGreaterThan(plans[1].bbox.y0);
});

it("retains a punctuation addition between adjacent retry regions without replacing it twice", () => {
  const words = [word("First", 96, 100), { ...word("!", 96, 128, 300), bbox: { x0: 300, y0: 128, x1: 305, y1: 130 } }, word("Second", 96, 134)];
  const lines = [90, 131].map((y, i) => ({ text: `${i ? "Second" : "First"} :`,
    bbox: { x0: 10, y0: y, x1: 500, y1: y + 40 },
    polygon: [{ x: 10, y }, { x: 500, y }, { x: 500, y: y + 40 }, { x: 10, y: y + 40 }] }));
  const comparison = compareLocatedPhotoText("First :\nSecond :", words, size, lines);
  expect(comparison.differences.some(item => item.observed.includes("!"))).toBe(true);
  const plans = planTextRetries(words, comparison, lines, size);
  const indices = plans.flatMap(plan => plan.indices);
  expect(indices.filter(index => index === 1)).toHaveLength(1);
  expect(new Set(indices).size).toBe(indices.length);
  const unchanged = applyTextRetries(words, plans.map(candidate => ({ candidate, words: candidate.indices.map(index => words[index]) })));
  expect(unchanged.words.some(word => word.text === "!")).toBe(true);
});

it("uses fixed observed phrase neighborhoods for short disagreements in a long row", () => {
  const tokens = ["|", "agree", "that", "|", "am", "personally", "liable", "for", "payment", "of", "this", "account", "and", "fees"];
  const words = tokens.map((text, index) => ({ ...word(text, 96, 100, 20 + index * 60),
    bbox: { x0: 20 + index * 60, y0: 100, x1: 70 + index * 60, y1: 125 } }));
  const comparison = comparePageReading(tokens.map(text => text === "|" ? "I" : text).join(" "), { words }, size);
  const plans = planTextRetries(words, comparison, null, size);
  expect(plans).toHaveLength(1);
  expect(plans[0].indices).toEqual([0, 1, 2, 3, 4, 5]);
  expect(plans[0].bbox.x1).toBeLessThan(words[6].bbox.x0);
});

it("accepts a localized stronger glyph reading without using the signed target", () => {
  const before = [word("|", 87), word("agree", 96, 100, 150), word("|", 90, 100, 300)];
  const after = before.map((word, index) => ({ ...word, text: index === 1 ? "agree" : "I", confidence: index === 1 ? 88 : 99 }));
  expect(preferTextRetry(before, after)).toBe(false);
  expect(preferTextRetry(before, after, { localized: true })).toBe(true);
  const merged = applyTextRetries(before, [{ candidate: { ...candidate, localized: true, indices: [0, 1, 2] }, words: after }]);
  expect(merged.retryReviews).toEqual([expect.objectContaining({ original: "| agree |", observed: "I agree I" })]);
  expect(comparePageReading("I agree I", merged, size).status).toBe("uncertain");
  expect(comparePageReading("| agree |", merged, size).status).toBe("differences");
});
it("requires every changed token to improve and correspond spatially in localized selection", () => {
  const before = [word("|", 87), word("agree", 96, 100, 150), word("|", 90, 100, 300)];
  const after = before.map((word, index) => ({ ...word, text: index === 1 ? "agree" : "I", confidence: index === 1 ? 88 : 99 }));
  for (const altered of [after.map((w, i) => i === 2 ? { ...w, confidence: 91 } : w),
    after.map((w, i) => i === 0 ? { ...w, confidence: 80 } : w),
    after.map((w, i) => i === 0 ? { ...w, bbox: { ...w.bbox, x0: 700, x1: 800 } } : w),
    after.map((w, i) => i === 0 ? { ...w, bbox: { x0: 20 } } : w)]) {
    expect(preferTextRetry(before, altered, { localized: true })).toBe(false);
  }
});
it("does not use the localized path to remove, join, split or move meaningful text", () => {
  const before = [word("Do", 96), word("not", 96, 100, 150), word("pay", 96, 100, 300)];
  for (const after of [[before[0], before[2]],
    [{ ...before[0], text: "Donot", confidence: 96 }, before[2]],
    [before[0], { ...before[1], text: "no" }, { ...before[1], text: "t" }, before[2]],
    [before[2], before[1], before[0]]]) {
    expect(preferTextRetry(before, after, { localized: true })).toBe(false);
  }
});

it("does not treat same-count word-boundary changes as localized glyph correction", () => {
  const before = [word("paym", 90), word("ent", 90, 100, 150)];
  const after = [{ ...before[0], text: "pay", confidence: 96 }, { ...before[1], text: "ment", confidence: 96 }];
  // Keep the aggregate row preference below its existing +3 condition.
  before.push(word("unchangedlongcontext", 99, 100, 300));
  after.push({ ...before[2], confidence: 85 });
  expect(preferTextRetry(before, after, { localized: true })).toBe(false);
});
