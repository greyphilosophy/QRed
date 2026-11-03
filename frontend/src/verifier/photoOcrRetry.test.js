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
