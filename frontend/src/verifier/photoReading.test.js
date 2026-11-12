import { expect, it } from "vitest";
import { comparePageReading, possiblePrintedMarkings } from "./photoReading.js";

const box = { x0: 100, y0: 200, x1: 160, y1: 260 };
const word = (text, x0, y0, width = 20) => ({ text, confidence: 99, bbox: { x0, y0, x1: x0 + width, y1: y0 + 12 } });
const text = [word("Friday", 10, 10)];
const caption = [word("Verify", 90, 280, 30), word("at", 125, 280, 10), word("qred.org", 140, 280, 40)];
const dimensions = { width: 600, height: 800 };

function registeredReading(signedLine, field, extras = [], { visual, reread = true, originalField = field } = {}) {
  const expected = ["Start", signedLine, "End"].join("\n");
  const pageWords = row => [word("Start", 60, 85), ...row, word("End", 60, 645), ...extras];
  const evidence = { ...dimensions, text: expected, layout: { mode: 3,
    lines: [.1, .5, .8].map(y => ({ x: .1, y, width: .65, height: .04 })) }, visual };
  const corners = [{x:0,y:0},{x:600,y:0},{x:600,y:800},{x:0,y:800}];
  return comparePageReading(expected, { words: pageWords(field), corners, originalReading: reread ? pageWords(originalField) : undefined }, dimensions, evidence);
}

it("retains lettering over original artwork for review and reports new text in a blank area", () => {
  const indices = new Uint8Array(20 * 20).fill(15);
  indices.fill(0, 6 * 20 + 4, 6 * 20 + 8);
  const visual = { codebook: 1, rows: 20, columns: 20, indices };
  const art = word("Crest", 125, 249, 90), addition = word("PAID", 400, 245, 42);
  const read = (extras, options) => registeredReading("Due", [word("Due", 60, 402)], extras, options);
  const review = read([art], { visual });
  expect(review.status).toBe("uncertain");
  expect(review.differences).toEqual([expect.objectContaining({ observed: "Crest", review: "artwork" })]);
  expect(review.words.at(-1)).toMatchObject({ status: "uncertain", agrees: false, bbox: art.bbox });
  expect(read([art, addition], { visual }).differences.find(d => d.observed === "PAID").review).toBeUndefined();
  expect(read([art], {}).status).toBe("differences");
});

it("keeps digit changes and missing signed words prominent even on a noisy reread", () => {
  const weak = text => ({ ...word(text, 165, 403), confidence: 35 });
  const amount = read => registeredReading("Amount 47.85", [word("Amount", 60, 403), weak(read)]);
  expect(amount("42.85").differences).toEqual([expect.objectContaining({ expected: "47.85", observed: "42.85" })]);
  expect(amount("42.85").status).toBe("differences");
  const unclear = amount("4l.8S");
  expect(unclear.status).toBe("uncertain");
  expect(unclear.differences[0].review).toBe("number");
  for (const [signed, read] of [["Do not pay", "Do pay"], ["I agree", "agree"], ["Pay 7", "Pay"]]) {
    const result = registeredReading(signed, read.split(" ").map((t, i) => word(t, 60 + i * 45, 403)));
    expect(result.status).toBe("differences");
    expect(result.differences[0].review).toBeUndefined();
  }
});

it("keeps weak original observations available when the clearer page still has a doubtful reading", () => {
  const field = [word("Status", 60, 403), { ...word("X", 180, 403), confidence: 32 }];
  const result = registeredReading("Status Y", field);
  expect(result.differences[0]).toMatchObject({ expected: "Y", observed: "X", review: "unclear" });
  expect(result.status).toBe("uncertain");
  expect(result.originalComparison.status).toBe("differences");
  expect(registeredReading("Status Y", field, [], { reread: false }).status).toBe("differences");
});

it("requires confident neighboring words in the same row to qualify a conflicting omission", () => {
  const row = (text, y = 403, confidence = 99) => text.split(" ").map((t, i) => ({ ...word(t, 60 + 40 * i, y), confidence }));
  const signed = "Allow two working days", field = row("Allow days");
  const read = originalField => registeredReading(signed, field, [], { originalField });
  const corroborated = read(row(signed));
  expect(corroborated.status).toBe("uncertain");
  expect(corroborated.differences[0]).toMatchObject({ expected: "two working", review: "firstReading" });
  for (const original of [row("two working"), row(signed, 250), row(signed, 403, 40)]) {
    expect(read(original).status).toBe("differences");
  }
  expect(registeredReading("Allow 2 days", field, [], { originalField: row("Allow 2 days") }).status).toBe("differences");
});

it("keeps a contrast-assisted agreement uncertain, and still detects changed or added text", () => {
  expect(comparePageReading("Friday", { words: text, contrastAssisted: true }, dimensions).status).toBe("uncertain");
  expect(comparePageReading("Monday", { words: text, contrastAssisted: true }, dimensions).status).toBe("differences");
  expect(comparePageReading("Friday", { words: [...text, word("extra", 10, 50)], contrastAssisted: true }, dimensions).status).toBe("differences");
  expect(comparePageReading("Friday", { words: [], contrastAssisted: true }, dimensions).status).toBe("unreadable");
});

it("retains a faint added word from the first reading even if the second agrees", () => {
  const first = [...text, { ...word("Paid", 10, 50), confidence: 35 }];
  const result = comparePageReading("Friday", { words: text, originalReading: first, contrastAssisted: true }, dimensions);
  expect(result.status).toBe("uncertain");
  expect(result.originalComparison.status).toBe("differences");
  expect(result.originalComparison.differences).toContainEqual(expect.objectContaining({ observed: "Paid", expected: "" }));
  expect(comparePageReading("Monday", { words: text, originalReading: first, contrastAssisted: true }, dimensions).status).toBe("differences");
});
it("separates likely QR markings for visible review without declaring a match", () => {
  const result = comparePageReading("Friday", { words: [...text, word("[=]", 110, 220), ...caption], codes: [box] }, dimensions);
  expect(result.status).toBe("uncertain");
  expect(result.differences).toEqual([]);
  expect(result.markings.map(mark => mark.observed)).toEqual(["[=]", "Verify at qred.org"]);
  expect(result.markings[1].boxes).toHaveLength(3);
});
it("keeps source indices stable after separating markings so retries target the right words", () => {
  const result = comparePageReading("Friday", { words: [word("[=]", 110, 220), word("Monday", 10, 10)], codes: [box] }, dimensions);
  expect(result.words[0]).toMatchObject({ sourceIndex: 1, text: "Monday", status: "different" });
  expect(result.differences[0].wordIndices).toEqual([1]);
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
it("still reports covered signed text when a copied stamp's glyphs are separated for review", () => {
  const result = comparePageReading("Invoice Friday", {
    words: [word("Invoice", 10, 10), word("[=]", 110, 220)], codes: [box],
  }, dimensions);
  expect(result.status).toBe("differences");
  expect(result.differences).toContainEqual(expect.objectContaining({ expected: "Friday", observed: "" }));
  expect(result.markings[0].observed).toBe("[=]");
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

// Exact raster observations from the synthetic live-browser regression. These
// are navigation artwork, not a document-text whitelist or a panel-sized mask.
const navigation = { x0: 1019.75, y0: 1389.75, x1: 1073.156, y1: 1443.156, kind: "navigation" };
const legacyCaption = [
  { text: "|", confidence: 42, bbox: { x0: 977, y0: 1462, x1: 984, y1: 1475 } },
  { text: "Verify", confidence: 87, bbox: { x0: 993, y0: 1459, x1: 1029, y1: 1475 } },
  { text: "at", confidence: 91, bbox: { x0: 1035, y0: 1460, x1: 1046, y1: 1470 } },
  { text: "qred.org_|", confidence: 0, bbox: { x0: 1048, y0: 1459, x1: 1115, y1: 1475 } },
];
const navReading = (words = legacyCaption, code = navigation, pageNumber = 1, expected = "Friday") =>
  comparePageReading(expected, { words: [...text, ...words], codes: [code] },
    { width: 1224, height: 1584 }, undefined, { pageNumber });

it.each(["qred.org_|", "qred.org_J"])("separates legacy navigation artwork %s on the first page, retaining its exact reading for review", url => {
  const words = legacyCaption.map((word, i) => i === 3 ? { ...word, text: url } : word);
  const result = navReading(words);
  expect(result.status).toBe("uncertain");
  expect(result.differences).toEqual([]);
  expect(result.markings).toEqual([{ observed: `| Verify at ${url}`, boxes: words.map(word => word.bbox) }]);
});
it("requires a decoded navigation link and authenticated first-page context for legacy artwork", () => {
  for (const page of [undefined, 0, 2]) {
    expect(navReading(legacyCaption, navigation, page === undefined ? null : page).status).toBe("differences");
  }
  expect(navReading(legacyCaption, { ...navigation, kind: undefined }).status).toBe("differences");
  expect(comparePageReading("Friday", { words: [...text, ...legacyCaption] }, dimensions).status).toBe("differences");
});
it("does not hide added words, changed addresses, arbitrary suffixes, or wrong-position bracket lookalikes", () => {
  for (const url of ["other.org_J", "qred.org_Paid", "qred.org_1", "qred.org_JPaid", "qred.org_JJ"]) {
    const result = navReading(legacyCaption.map((word, i) => i === 3 ? { ...word, text: url } : word));
    expect(result.status, url).toBe("differences");
    expect(result.differences.some(difference => difference.observed.includes(url))).toBe(true);
  }
  const paid = { text: "Paid", confidence: 99, bbox: { x0: 993, y0: 1480, x1: 1029, y1: 1496 } };
  expect(navReading([...legacyCaption, paid]).differences.map(d => d.observed)).toContain("Paid");
  const movedSuffix = legacyCaption.map((word, i) => i === 3 ? { ...word, bbox: { ...word.bbox, x1: 1090 } } : word);
  expect(navReading(movedSuffix).status).toBe("differences");
  const movedPrefix = legacyCaption.map((word, i) => i === 0 ? { ...word, bbox: { ...word.bbox, x0: 990, x1: 997 } } : word);
  expect(navReading(movedPrefix).differences.map(d => d.observed)).toContain("|");
});
it("does not omit signed words, or let copied navigation hide missing document content", () => {
  const exact = navReading(legacyCaption, navigation, 1, "Friday | Verify at qred.org_|");
  expect(exact.markings).toEqual([]);
  expect(exact.differences).toEqual([]);
  const covered = navReading(legacyCaption, navigation, 1, "Friday Approved");
  expect(covered.status).toBe("differences");
  expect(covered.differences).toContainEqual(expect.objectContaining({ expected: "Approved", observed: "" }));
});
it("recognizes an undecorated eight-point caption beside the compact navigation QR", () => {
  const clean = legacyCaption.slice(1).map((word, i) => i === 2
    ? { ...word, text: "qred.org", bbox: { ...word.bbox, x1: 1101 } } : word);
  expect(navReading(clean).differences).toEqual([]);
  expect(navReading(clean).markings.map(mark => mark.observed)).toEqual(["Verify at qred.org"]);
});

it.each([.5, 1.5, 2])("keeps legacy navigation classification scale-independent at %s×", scale => {
  const scaledBox = box => Object.fromEntries(Object.entries(box).map(([key, value]) => [key, value * scale]));
  const code = { ...scaledBox({ x0: navigation.x0, y0: navigation.y0, x1: navigation.x1, y1: navigation.y1 }), kind: "navigation" };
  const result = navReading(legacyCaption.map(word => ({ ...word, bbox: scaledBox(word.bbox) })), code);
  expect(result.differences).toEqual([]);
});
it("handles either legacy corner separately without expanding the accepted URL grammar", () => {
  const noPrefix = legacyCaption.slice(1);
  expect(navReading(noPrefix).differences).toEqual([]);
  const noSuffix = legacyCaption.map((word, index) => index === 3
    ? { ...word, text: "qred.org", bbox: { ...word.bbox, x1: 1101 } } : word);
  expect(navReading(noSuffix).differences).toEqual([]);
  expect(navReading(noSuffix).markings[0].observed).toBe("| Verify at qred.org");
});

it("handles joined legacy caption words from the bundled-font renderer without correcting their spelling", () => {
  const joined = [
    { text: "Verify", confidence: 44, bbox: { x0: 977, y0: 1460, x1: 1029, y1: 1475 } },
    { text: "atgred.org_|", confidence: 36, bbox: { x0: 1033, y0: 1459, x1: 1115, y1: 1475 } },
  ];
  const result = navReading(joined);
  expect(result.differences).toEqual([]);
  expect(result.markings[0].observed).toBe("Verify atgred.org_|");
  expect(result.status).toBe("uncertain");
  const single = [{ text: "|Verifyatqred.org_J", confidence: 20,
    bbox: { x0: 977, y0: 1459, x1: 1115, y1: 1475 } }];
  expect(navReading(single).differences).toEqual([]);
  expect(navReading(single).markings[0].observed).toBe("|Verifyatqred.org_J");
  const misplaced = single.map(word => ({ ...word, bbox: { ...word.bbox, x0: 995 } }));
  expect(navReading(misplaced).status).toBe("differences");
  const missing = navReading(single, navigation, 1, "Friday Approved");
  expect(missing.differences).toContainEqual(expect.objectContaining({ expected: "Approved", observed: "" }));
  const injected = joined.map((word, index) => index === 1 ? { ...word, text: "atgred.org_Paid" } : word);
  expect(navReading(injected).differences.some(d => d.observed.includes("Paid"))).toBe(true);
  expect(navReading(joined, navigation, 2).status).toBe("differences");
});
