import { expect, it } from "vitest";
import { applyTextRetries, MAX_TEXT_RETRIES, planTextRetries, preferTextRetry } from "./photoOcrRetry.js";
import { comparePageReading } from "./photoReading.js";
import { compareLocatedPhotoText } from "./photoTextLayout.js";

const size = { width: 1000, height: 1400 };
const word = (text, confidence = 60, y = 100, x = 20) => ({ text, confidence, lineId: `line-${y}`,
  bbox: { x0: x, y0: y, x1: x + 100, y1: y + 25 } });
const candidate = { indices: [0], bbox: { x0: 10, y0: 90, x1: 140, y1: 140 } };

it("isolates only the disputed date in a row and leaves adjacent fields in place", () => {
  const words = [word("Start", 98), word("03-14-29", 42, 100, 140), word("19.50", 99, 100, 244),
    word("End", 98, 250), word("03-18-27", 98, 250, 140)];
  const signed = "Start 03-14-27 19.50 End 03-18-27";
  const plans = planTextRetries(words, comparePageReading(signed, { words }, size), null, size);
  expect(plans).toEqual([{ dateField: true, signedDate: "03-14-27", indices: [1], priority: -1,
    bbox: { x0: 134, x1: 244, y0: 95, y1: 130 } }]);

  const changed = applyTextRetries(words, [{ candidate: plans[0], words: [word("03-14-27", 93, 100, 140)] }]);
  expect(changed.words.map(w => w.text)).toEqual(["Start", "03-14-27", "19.50", "End", "03-18-27"]);
  expect(changed.retryReviews).toEqual([expect.objectContaining({ signedDate: "03-14-27",
    original: "03-14-29", observed: "03-14-27", boxes: [plans[0].bbox] })]);
  expect(comparePageReading(signed, changed, size).status).toBe("uncertain");
  const extra = { ...changed, words: [...changed.words, word("amended", 98, 350)] };
  expect(comparePageReading(signed, extra, size).differences).toContainEqual(expect.objectContaining({ observed: "amended" }));
});

it.each([
  ["03-14-29", 40, "03-14-29", 95, false],
  ["03-14-29", 94, "03-14-27", 99, true],
  ["03-14-29", 42, "03-14-27", 65, true],
  ["03-14-2", 38, "03-14-27", 99, true],
  ["03-14-29", 35, "", 99, false],
])("keeps the photographed discrepancy for %s (%i) followed by %s (%i)", (first, confidence, closer, secondConfidence, review) => {
  const date = { ...candidate, dateField: true, signedDate: "03-14-27" };
  const merged = applyTextRetries([word(first, confidence)], [{ candidate: date, words: [word(closer, secondConfidence)] }]);
  expect(merged.words[0].text).toBe(first);
  expect(merged.retryReviews).toHaveLength(review ? 1 : 0);
  if (review) expect(merged.retryReviews[0]).toMatchObject({ observed: closer, lowConfidence: secondConfidence < 85 });
  expect(comparePageReading("03-14-27", merged, size).status).toBe("differences");
});

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
