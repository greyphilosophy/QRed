import { expect, it } from "vitest";
import { comparePageReading } from "./photoReading.js";
import { compareLocatedPhotoText, signedPhotoLines } from "./photoTextLayout.js";

const size = { width: 1000, height: 1400 };
const corners = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1400 }, { x: 0, y: 1400 }];
const text = "Item Charge Credit\nRoom 125.50 0.00\nTax 5.25 0.00";
const evidence = { text, ...size, layout: { mode: 3, lines: [0, 1, 2].map(i => ({ x: .1, y: .1 + i * .1, width: .8, height: .04 })) } };
const word = (text, x, y, confidence = 97) => ({ text, confidence, bbox: { x0: x, y0: y, x1: x + 100, y1: y + 22 } });
const words = [word("Item", 120, 150), word("Room", 120, 290), word("Tax", 120, 430),
  word("Charge", 450, 150), word("125.50", 450, 290), word("5.25", 450, 430),
  word("Credit", 720, 150), word("0.00", 720, 290), word("0.00", 720, 430)];

it("compares a column-first OCR table by its signed row locations", () => {
  expect(comparePageReading(text, { words }, size).status).toBe("differences");
  const result = comparePageReading(text, { words, corners }, size, evidence);
  expect(result).toMatchObject({ status: "matches", lineAware: true, differences: [], matchedCount: 9 });
  expect(result.words.map(w => w.sourceIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

it("does not accept swapped amounts or rows just because the same words exist", () => {
  for (const [a, b] of [[4, 5], [1, 2]]) {
    const swapped = words.map((w, i) => ({ ...w, text: i === a ? words[b].text : i === b ? words[a].text : w.text }));
    expect(comparePageReading(text, { words: swapped, corners }, size, evidence).status).toBe("differences");
  }
});

it("keeps additions outside signed boxes and locates a wholly missing line", () => {
  const added = comparePageReading(text, { words: [...words, word("Paid", 120, 700)], corners }, size, evidence);
  expect(added.status).toBe("differences");
  expect(added.differences).toContainEqual(expect.objectContaining({ expected: "", observed: "Paid" }));
  const removed = comparePageReading(text, { words: words.filter(w => w.bbox.y0 !== 290), corners }, size, evidence);
  expect(removed.status).toBe("differences");
  expect(removed.differences).toContainEqual(expect.objectContaining({ expected: "Room 125.50 0.00", observed: "", boxes: [expect.any(Object)] }));
});

it("maps line boxes through camera perspective and keeps crop coordinates on the photo", () => {
  const skew = [{ x: 30, y: 50 }, { x: 940, y: 85 }, { x: 980, y: 1340 }, { x: 60, y: 1310 }];
  const lines = signedPhotoLines(text, evidence, skew, size);
  const located = lines.flatMap(line => line.text.split(" ").map((text, i) => {
    const u = (i + .5) / 3;
    const top = { x: line.polygon[0].x * (1-u) + line.polygon[1].x * u, y: line.polygon[0].y * (1-u) + line.polygon[1].y * u };
    const bottom = { x: line.polygon[3].x * (1-u) + line.polygon[2].x * u, y: line.polygon[3].y * (1-u) + line.polygon[2].y * u };
    return word(text, (top.x + bottom.x) / 2 - 50, (top.y + bottom.y) / 2 - 11);
  })).reverse();
  expect(comparePageReading(text, { words: located, corners: skew }, size, evidence).status).toBe("matches");
});

it("falls back for coarse locations, unanchored missing borders, and expanded footer pages", () => {
  for (const mode of [1, 2]) expect(signedPhotoLines(text, { ...evidence, layout: { ...evidence.layout, mode } }, corners, size)).toBeNull();
  expect(signedPhotoLines(text, evidence, null, size)).toBeNull();
  expect(signedPhotoLines(text, { ...evidence, width: 612, height: 792 },
    [{x:0,y:0},{x:612,y:0},{x:612,y:1008},{x:0,y:1008}], {width:612,height:1008})).toBeNull();
});

it("keeps disagreement between original and retry visible even if the displayed reading matches", () => {
  expect(comparePageReading(text, { words, corners, retryReviews: [{ original: "925.50", observed: "125.50", boxes: [] }] }, size, evidence).status).toBe("uncertain");
});

function printedFixture() {
  const content = "Invoice reference ABC123\nItem Charge Credit\nRoom 125.50 0.00\nTax 5.25 0.00\nPayment due Friday\nDocument reference XYZ789";
  const lines = content.split("\n");
  const boxes = [.08, .2, .3, .4, .65, .85].map(y => ({ x: .1, y, width: .8, height: .02 }));
  const reading = lines.flatMap((line, row) => line.split(" ").map((text, col, list) => {
    const x = (.1 + .8 * (col + .5) / list.length) * .94 + .03;
    const y = (boxes[row].y + .01) * .94 + .025;
    return { ...word(text, x * size.width - 50, y * size.height - 11), lineId: row };
  }));
  return { content, reading, evidence: { text: content, ...size, layout: { mode: 3, lines: boxes } } };
}

it("registers one printer scale and offset using distinctive lines spread across the page", () => {
  const fixture = printedFixture();
  // Faint exact anchors can establish location, but retain their low confidence.
  fixture.reading.at(-1).confidence = 40;
  const result = comparePageReading(fixture.content, { words: fixture.reading, corners }, size, fixture.evidence);
  expect(result).toMatchObject({ status: "uncertain", lineAware: true, differences: [], uncertainCount: 1 });
});

it("does not let global printer registration move individual changed rows to a matching location", () => {
  const fixture = printedFixture();
  const altered = fixture.reading.map(w => ({ ...w, text: w.text === "125.50" ? "5.25" : w.text === "5.25" ? "125.50" : w.text }));
  const result = comparePageReading(fixture.content, { words: altered, corners }, size, fixture.evidence);
  expect(result).toMatchObject({ status: "differences", lineAware: true });
  expect(result.differences).toContainEqual(expect.objectContaining({ context: "Room 125.50 0.00", observed: "5.25" }));
  expect(result.differences).toContainEqual(expect.objectContaining({ context: "Tax 5.25 0.00", observed: "125.50" }));
});

it("does not calibrate to duplicated anchors and falls back when the border cannot locate the text", () => {
  const fixture = printedFixture();
  const duplicates = fixture.reading.map(w => ({ ...w, lineId: `copy-${w.lineId}`,
    bbox: { ...w.bbox, y0: w.bbox.y0 + 20, y1: w.bbox.y1 + 20 } }));
  const doubled = [...fixture.reading, ...duplicates];
  const lines = signedPhotoLines(fixture.content, fixture.evidence, corners, size, doubled);
  expect(lines[0].bbox).toEqual(signedPhotoLines(fixture.content, fixture.evidence, corners, size)[0].bbox);
  expect(comparePageReading(fixture.content, { words: doubled, corners }, size, fixture.evidence).status).toBe("differences");
  const tooFar = fixture.reading.map(w => ({ ...w, bbox: { ...w.bbox, x0: w.bbox.x0 + 200, x1: w.bbox.x1 + 200 } }));
  expect(signedPhotoLines(fixture.content, fixture.evidence, corners, size, tooFar)).toBeNull();
});

it("retains the page-wide token limit even when signed regions partition the comparison", () => {
  expect(() => compareLocatedPhotoText("word ".repeat(4001), [], size, [])).toThrow(/too much text/);
});

it("locates borderless PDF renders using independently anchored geometry, not OCR reading order", () => {
  const fixture = printedFixture();
  const shuffled = [...fixture.reading].sort((a, b) => b.lineId - a.lineId);
  const result = comparePageReading(fixture.content, { words: shuffled }, size, fixture.evidence);
  expect(result).toMatchObject({ status: "matches", lineAware: true, differences: [] });
});

it("keeps swapped, missing, extra and uncertain text visible on borderless renders", () => {
  const fixture = printedFixture();
  const altered = fixture.reading.map(w => ({ ...w, text: w.text === "125.50" ? "5.25" : w.text === "5.25" ? "125.50" : w.text }));
  expect(comparePageReading(fixture.content, { words: altered }, size, fixture.evidence))
    .toMatchObject({ status: "differences", lineAware: true });
  const missing = fixture.reading.filter(w => w.lineId !== 2);
  expect(comparePageReading(fixture.content, { words: missing }, size, fixture.evidence).differences)
    .toContainEqual(expect.objectContaining({ expected: "Room 125.50 0.00", observed: "", boxes: [expect.any(Object)] }));
  const extra = [...fixture.reading, word("Paid", 20, 700)];
  expect(comparePageReading(fixture.content, { words: extra }, size, fixture.evidence).differences)
    .toContainEqual(expect.objectContaining({ expected: "", observed: "Paid" }));
  fixture.reading.at(-1).confidence = 40;
  expect(comparePageReading(fixture.content, { words: fixture.reading }, size, fixture.evidence))
    .toMatchObject({ status: "uncertain", lineAware: true, uncertainCount: 1 });
});

it("does not infer a borderless page from sparse, duplicated, narrow-spread or aspect-mismatched anchors", () => {
  const fixture = printedFixture();
  for (const reading of [[], fixture.reading.filter(w => w.lineId === 0 || w.lineId === 5),
    fixture.reading.filter(w => w.lineId < 4), [...fixture.reading, ...fixture.reading.map(w => ({ ...w, lineId: `copy-${w.lineId}` }))]]) {
    expect(signedPhotoLines(fixture.content, fixture.evidence, null, size, reading)).toBeNull();
  }
  expect(signedPhotoLines(fixture.content, fixture.evidence, null, { ...size, height: 1800 }, fixture.reading)).toBeNull();
});

it("matches an invoice heading beside an address even when PDF and OCR traverse different columns", () => {
  const content = "Example Guest\n123 Example Street\nExample City\nUnited States\nINVOICE\nPayment due Friday\nDocument reference XYZ789";
  const boxes = [
    { x: .05, y: .1, width: .3, height: .03 },
    { x: .05, y: .15, width: .3, height: .03 },
    { x: .05, y: .2, width: .3, height: .03 },
    { x: .05, y: .25, width: .3, height: .03 },
    { x: .7, y: .1, width: .2, height: .03 },
    { x: .1, y: .65, width: .8, height: .03 },
    { x: .1, y: .85, width: .8, height: .03 },
  ];
  const rows = content.split("\n").map((text, i) => ({ text, confidence: 99, lineId: i,
    bbox: { x0: boxes[i].x * size.width, x1: (boxes[i].x + boxes[i].width) * size.width,
      y0: boxes[i].y * size.height, y1: (boxes[i].y + boxes[i].height) * size.height } }));
  const reading = [rows[0], rows[4], rows[1], rows[2], rows[3], rows[5], rows[6]];
  expect(comparePageReading(content, { words: reading }, size).status).toBe("differences");
  const reference = { text: content, ...size, layout: { mode: 3, lines: boxes } };
  expect(comparePageReading(content, { words: reading }, size, reference))
    .toMatchObject({ lineAware: true, status: "matches", differences: [] });
  const missing = comparePageReading(content, { words: reading.filter(w => w.lineId !== 3) }, size, reference);
  expect(missing.differences).toEqual([expect.objectContaining({ expected: "United States", observed: "", boxes: [expect.any(Object)] })]);
});

const innerFrame = [{ x: 100, y: 140 }, { x: 900, y: 140 }, { x: 900, y: 1260 }, { x: 100, y: 1260 }];
it("recovers a wrong inner-frame detection only through independently anchored full-raster geometry", () => {
  const fixture = printedFixture();
  const shuffled = [...fixture.reading].sort((a, b) => b.lineId - a.lineId);
  const result = comparePageReading(fixture.content, { words: shuffled, corners: innerFrame }, size, fixture.evidence);
  expect(result).toMatchObject({ status: "matches", lineAware: true, differences: [] });
  expect(signedPhotoLines(fixture.content, fixture.evidence, innerFrame, size, shuffled))
    .toEqual(signedPhotoLines(fixture.content, fixture.evidence, null, size, shuffled));
});
it("rejects inner-frame fallback without matching full aspect and sufficient distinct spread anchors", () => {
  const fixture = printedFixture();
  for (const reading of [fixture.reading.filter(w => w.lineId === 0 || w.lineId === 5),
    fixture.reading.filter(w => w.lineId < 4),
    [...fixture.reading, ...fixture.reading.map(w => ({ ...w, lineId: `copy-${w.lineId}` }))]]) {
    expect(signedPhotoLines(fixture.content, fixture.evidence, innerFrame, size, reading)).toBeNull();
  }
  expect(signedPhotoLines(fixture.content, fixture.evidence, innerFrame,
    { ...size, height: 1800 }, fixture.reading)).toBeNull();
});
it("keeps swapped, missing and added text detectable after rejecting an inner frame", () => {
  const fixture = printedFixture();
  const changed = fixture.reading.map(w => ({ ...w, text: w.text === "125.50" ? "5.25" : w.text === "5.25" ? "125.50" : w.text }));
  const altered = comparePageReading(fixture.content, { words: changed, corners: innerFrame }, size, fixture.evidence);
  expect(altered).toMatchObject({ status: "differences", lineAware: true });
  expect(altered.differences).toContainEqual(expect.objectContaining({ context: "Room 125.50 0.00", observed: "5.25" }));
  expect(altered.differences).toContainEqual(expect.objectContaining({ context: "Tax 5.25 0.00", observed: "125.50" }));
  const missing = comparePageReading(fixture.content, { words: fixture.reading.filter(w => w.lineId !== 2), corners: innerFrame }, size, fixture.evidence);
  expect(missing.differences).toContainEqual(expect.objectContaining({ expected: "Room 125.50 0.00", observed: "", boxes: [expect.any(Object)] }));
  const extra = comparePageReading(fixture.content, { words: [...fixture.reading, word("Added", 20, 700)], corners: innerFrame }, size, fixture.evidence);
  expect(extra.differences).toContainEqual(expect.objectContaining({ expected: "", observed: "Added" }));
});
