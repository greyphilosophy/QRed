import { expect, it } from "vitest";
import { applyTextRetries, MAX_TEXT_RETRIES, planTextRetries, preferTextRetry } from "./photoOcrRetry.js";
import { comparePageReading } from "./photoReading.js";
import { compareLocatedPhotoText } from "./photoTextLayout.js";
import { createReviewItems } from "./reviewFindings.js";

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
  expect(changed.retryReviews).toEqual([]);
  expect(comparePageReading(signed, changed, size).status).toBe("matches");
  const extra = { ...changed, words: [...changed.words, word("amended", 98, 350)] };
  expect(comparePageReading(signed, extra, size).differences).toContainEqual(expect.objectContaining({ observed: "amended" }));
});

it.each([
  ["03-14-29", 40, "03-14-29", 95, false],
  ["03-14-29", 94, "03-14-27", 99, true],
  ["03-14-29", 42, "03-14-27", 65, true],
  ["03-14-2", 38, "03-14-28", 99, true],
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
  const words = [word("Pay"), word("123.4S", 60, 100, 150), word("Friday", 98, 200)];
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

it("retains an independently read numeric column when a noisy row label prevents replacing the row", () => {
  const anchor = word("year", 96, 100, 170);
  const original = [word("Nextinspction", 34), anchor];
  const line = { indices: [0, 1], signedLine: true, signedText: "Next inspection year 2037",
    bbox: { x0: 10, y0: 90, x1: 750, y1: 140 } };
  const retry = [word("Next", 52), word("inspction", 28, 100, 55), anchor];
  for (const value of ["2037", "2032"]) {
    const number = word(value, 95, 100, 580);
    expect(applyTextRetries(original, [{ candidate: line, words: [...retry, number] }]).words)
      .toEqual([...original, number]);
  }
  const number = word("2037", 95, 100, 580);
  const conflicting = [...original, word("2032", 94, 100, 580)];
  expect(applyTextRetries(conflicting, [{ candidate: { ...line, indices: [0, 1, 2] },
    words: [...retry, number] }]).words).toEqual(conflicting);
  for (const after of [[...retry, { ...number, confidence: 66 }],
    [...retry, word("-", 90, 100, 470), number], [...retry.slice(0, 2), number],
    [...retry, word("2037", 95, 126, 580)]]) {
    expect(applyTextRetries(original, [{ candidate: line, words: after }]).words).toEqual(original);
  }
  const partial = applyTextRetries([anchor], [{ candidate: { ...line, indices: [0], signedText: "year 2037" },
    words: [anchor, word("extra", 30, 100, 300), number] }]);
  expect(partial.words).toEqual([anchor, number]);
  expect(partial.retryReviews).toHaveLength(1);
});

it("discards a confirmed signed ending while preserving unresolved or misplaced readings", () => {
  const label = word("Balance", 98);
  const amount = word("0.00", 96, 100, 200);
  const line = { ...candidate, signedText: "Balance 0.00" };
  const run = (before, after, crop = line) => applyTextRetries(before, [{ candidate: crop, words: after }]);
  const completed = run([label], [label, amount]);
  expect(completed.retryReviews).toEqual([]);
  expect(comparePageReading(line.signedText, completed, size).status).toBe("matches");
  expect(run([label], [label, { ...amount, text: "8.00" }]).retryReviews).toHaveLength(1);
  expect(run([{ ...label, confidence: 47 }], [label, amount]).retryReviews).toEqual([]);
  expect(run([label], [word("Balance", 98, 200), amount]).retryReviews).toHaveLength(1);
  expect(run([label], [label, amount], candidate).retryReviews).toHaveLength(1);
});

it("keeps only the missing colon after a focused crop recovers the printed page number", () => {
  const before = [word("‘dof", 40), word("2", 96, 100, 195)];
  const after = [word("1", 96), word("of", 93, 100, 85), before[1]];
  const crop = { ...candidate, indices: [0, 1], signedText: ":1 of 2" };
  const result = applyTextRetries(before, [{ candidate: crop, words: after }]);
  expect(result.retryReviews).toEqual([]);
  expect(comparePageReading(crop.signedText, result, size).differences)
    .toEqual([expect.objectContaining({ expected: ":", observed: "" })]);
});

it.each([
  ["1 of 3", "‘dof", ["1", "of"], "2", "3"],
  ["California 2017", "Califomia", ["California"], "2012", "2017"],
])("asks only about the consistently different number in %s", (signed, noisy, recovered, number, expected) => {
  const value = word(number, 96, 100, 210);
  const before = [word(noisy, 45), value];
  const after = [...recovered.map((text, i) => word(text, 94, 100, 20 + i * 72)), value];
  const crop = { indices: [0, 1], bbox: { x0: 10, y0: 90, x1: 350, y1: 140 } };
  const compare = words => comparePageReading(signed, { words }, size);
  for (const candidate of [crop, { ...crop, signedLine: true, signedText: signed }]) {
    const retry = first => applyTextRetries(first, [{ candidate, words: after }], compare);
    const settled = retry(before);
    expect(settled.retryReviews).toEqual([]);
    expect(createReviewItems(comparePageReading(signed, settled, size)).map(item => item.difference))
      .toEqual([expect.objectContaining({ observed: number, expected })]);
    expect(retry([before[0], { ...value, text: "8", confidence: 38 }]).retryReviews).toHaveLength(1);
    expect(retry([before[0], word(number, 39, 100, 150)]).retryReviews).toHaveLength(1);
  }
});

it("keeps a faint separate addition even when the closer reading matches the signed line", () => {
  const before = [word("Page", 93), word("VOID", 39, 100, 140), word("one", 98, 100, 280), word("of", 97, 100, 420),
    word("two", 97, 100, 560)];
  const after = before.filter(w => w.text !== "VOID").map(w => ({ ...w, confidence: 99 }));
  const result = applyTextRetries(before, [{ candidate: { ...candidate, indices: [0, 1, 2, 3, 4], signedText: "Page one of two" },
    words: after }]);
  expect(result.words).toEqual(after);
  expect(result.retryReviews).toHaveLength(1);
  expect(result.resolvedCrops).toEqual([]);
});

it("trims retry padding before it clips the edge of the next line", () => {
  const words = [word("TotaI", 50), word("Following", 98, 127)];
  const comparison = comparePageReading("Total Following", { words }, size);
  const plans = planTextRetries(words, comparison, null, size);
  expect(plans).toHaveLength(1);
  expect(plans[0].indices).toEqual([0]);
  expect(plans[0].bbox.y1).toBe(127);
});

it("rejects a crop that clips a neighboring word even if its center is outside", () => {
  const words = [word("TotaI", 50), word("Neighbor", 98, 124, 80)];
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

it("isolates a numeric value after a field separator when the full signed row clips another line", () => {
  const words = [word("Page", 96), word("til'of2", 0, 100, 200), word("Next", 98, 125, 350)];
  const bbox = { x0: 18, y0: 90, x1: 400, y1: 130 };
  const lines = [{ text: "Page :1 of 2", bbox, polygon: [{x:18,y:90},{x:400,y:90},{x:400,y:130},{x:18,y:130}] }];
  const comparison = { words: words.map((w, i) => ({ sourceIndex: i, status: i === 1 ? "different" : "matched" })),
    differences: [{ expected: ":1 of 2", wordIndices: [1] }] };
  const retries = planTextRetries(words, comparison, lines, size);
  expect(retries).toHaveLength(1);
  expect(retries[0]).toMatchObject({ separatedValue: true, signedText: ":1 of 2", indices: [1] });
  const changed = [word("1", 96, 100, 200), word("of", 91, 100, 235), word("3", 96, 100, 275)];
  changed[0].precedingSeparatorBox = { x0: 201, y0: 105, x1: 203, y1: 114 };
  const result = applyTextRetries(words, [{ candidate: retries[0], words: changed }]);
  expect(result.words.map(w => w.text)).toContain("3");
  expect(comparePageReading("Page :1 of 2 Next", result, size).differences)
    .toContainEqual(expect.objectContaining({ expected: "2", observed: "3" }));
});

it("rereads a doubtful amount from its own cell and keeps a confirmed digit change visible", () => {
  const signed = "Tax 5.31";
  const label = word("Tax", 98), firstAmount = word("8.34", 55, 100, 300);
  const first = [label, firstAmount];
  const comparison = comparePageReading(signed, { words: first }, size);
  const [crop] = planTextRetries(first, comparison, null, size);
  expect(crop).toMatchObject({ indices: [1], signedText: "5.31" });
  const read = amount => applyTextRetries(first, [{ candidate: crop, words: [{ ...firstAmount, text: amount, confidence: 96 }] }]);
  expect(comparePageReading(signed, read("5.31"), size)).toMatchObject({ status: "matches", differences: [] });
  expect(comparePageReading(signed, read("8.34"), size).differences).toContainEqual(expect.objectContaining({
    expected: "5.31", observed: "8.34",
  }));
});

it("prioritizes the isolated page count even when its whole label fits in a crop", () => {
  const words = [word("Page", 96), word("til'of2", 0, 100, 200)];
  const bbox = { x0: 18, y0: 90, x1: 400, y1: 130 };
  const lines = [{ text: "Page :1 of 2", bbox,
    polygon: [{ x: 18, y: 90 }, { x: 400, y: 90 }, { x: 400, y: 130 }, { x: 18, y: 130 }] }];
  const comparison = { words: [{ sourceIndex: 0, status: "matched" }, { sourceIndex: 1, status: "different" }],
    differences: [{ expected: ":1 of 2", wordIndices: [1] }] };
  expect(planTextRetries(words, comparison, lines, size)[0]).toMatchObject({
    indices: [1], separatedValue: true, signedText: ":1 of 2",
  });
});

it("rereads an amount when the first pass loses its decimal point", () => {
  const signed = "Tax 3.41";
  const first = [word("Tax", 98), word("341", 76, 100, 300)];
  const comparison = comparePageReading(signed, { words: first }, size);
  const [crop] = planTextRetries(first, comparison, null, size);
  expect(crop).toMatchObject({ indices: [1], signedText: "3.41" });
  for (const printed of ["3.41", "341", "3.47"]) {
    const words = [{ ...first[1], text: printed, confidence: 98 }];
    const result = applyTextRetries(first, [{ candidate: crop, words }]);
    const findings = createReviewItems(comparePageReading(signed, result, size));
    if (printed === "3.41") expect(findings).toEqual([]);
    else expect(findings.some(item => item.difference.observed === printed)).toBe(true);
  }
});

it("isolates the number when OCR damages the separator and changes a digit in the same field", () => {
  const signed = "Desk : 475";
  const field = [word("Desk", 96), { ...word("i", 45, 100, 200), bbox: { x0: 200, x1: 204, y0: 100, y1: 118 } },
    word("476.", 70, 100, 230)];
  const comparison = comparePageReading(signed, { words: field }, size);
  const [crop] = planTextRetries(field, comparison, null, size);
  expect(crop).toMatchObject({ indices: [2], signedText: "475" });
  for (const photographed of ["475", "476"]) {
    const result = applyTextRetries(field, [{ candidate: crop, words: [{ ...field[2], text: photographed, confidence: 98 }] }]);
    const findings = createReviewItems(comparePageReading(signed, result, size));
    expect(findings.some(item => item.difference.observed.includes("i"))).toBe(true);
    expect(findings.some(item => item.difference.observed.includes("476"))).toBe(photographed === "476");
  }
});

it("rereads both adjacent totals when only the empty padding between their rows overlaps", () => {
  const line = (text, y0) => ({ text, bbox: { x0: 20, x1: 600, y0, y1: y0 + 29 },
    polygon: [{ x: 20, y: y0 }, { x: 600, y: y0 }, { x: 600, y: y0 + 29 }, { x: 20, y: y0 + 29 }] });
  const lines = [line("Charge 400.12", 100), line("Credit 400.12", 132)];
  const words = [word("Charge", 96, 102), word("Credit", 96, 134)];
  const compare = next => compareLocatedPhotoText(lines.map(l => l.text).join("\n"), next, size, lines);
  const plans = planTextRetries(words, compare(words), lines, size);
  expect(plans).toHaveLength(2);
  expect(plans[0].bbox.y1).toBeLessThanOrEqual(plans[1].bbox.y0);
  const reread = applyTextRetries(words, plans.map((candidate, i) => ({ candidate, words: [words[i],
    word(i ? "400.13" : "400.12", 97, i ? 134 : 102, 460)] })), compare);
  expect(compare(reread.words).differences).toEqual([expect.objectContaining({ expected: "400.12", observed: "400.13" })]);
});
