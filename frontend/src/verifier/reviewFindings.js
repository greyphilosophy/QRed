// Review decisions describe a person's observations. They never change an OCR
// result, signature verdict, or the signed reference, and are never persisted.
export const REVIEW_DECISIONS = { matches: "Matches sealed text", differs: "Printed text differs", unsure: "Can't tell" };

export function findingBoxes(difference, comparison) {
  return difference.boxes || (difference.wordIndices || []).flatMap(index => {
    const box = comparison?.words.find(word => word.sourceIndex === index)?.bbox;
    return box ? [box] : [];
  });
}

function reason(d) {
  if (d.spacing) return "Word spacing";
  if (d.typography) return "Typography";
  if (d.review === "artwork") return "Lettering outside signed text";
  if (/\d/u.test((d.expected || "") + (d.observed || ""))) return "Number or date";
  if (d.review === "firstReading") return "Conflicting readings";
  if (d.review) return "Unclear reading";
  if (!d.observed) return "Possible missing text";
  if (!d.expected) return "Possible extra text";
  return "Text to check";
}

export function createReviewItems(comparison) {
  if (!comparison) return [];
  const items = [], duplicates = new Map();
  function add(id, difference, source, options = {}) {
    const boxes = findingBoxes(difference, source);
    const item = { id, difference: { ...difference, boxes }, reason: reason(difference),
      inspection: difference.review === "artwork", notes: [], ...options };
    // Identical readings at the same place share a decision. Different wording
    // or different geometry must remain separately reviewable, including faint
    // additions seen only before contrast enhancement.
    const key = JSON.stringify([difference.expected, difference.observed, boxes, item.inspection]);
    const existing = boxes.length && duplicates.get(key);
    if (existing) {
      existing.notes.push(...item.notes);
      if (item.readings) { existing.readings = item.readings; existing.reason = item.reason; }
      return;
    }
    items.push(item);
    if (boxes.length) duplicates.set(key, item);
  }
  function addComparison(source, prefix) {
    const covered = new Set();
    for (const [index, d] of (source.differences || []).entries()) {
      (d.wordIndices || []).forEach(i => covered.add(i));
      if (d.review === "sourceSeparator") continue;
      add(`${prefix}-${index}`, d, source, { source: prefix,
        notes: prefix === "original" ? ["The first reading found this. Check the original photo; contrast enhancement can hide pale marks."] : [],
      });
    }
    for (const word of source.words || []) {
      if (word.status !== "uncertain" || covered.has(word.sourceIndex)) continue;
      add(`${prefix}-word-${word.sourceIndex}`, { expected: word.agrees ? word.text : undefined,
        observed: word.text, wordIndices: [word.sourceIndex] }, source, {
        reason: /\d/u.test(word.text) ? "Unclear number or date" : "Unclear reading",
        inspection: !word.agrees, source: prefix,
        notes: ["The text reader was unsure about these characters. Check them on the paper."],
      });
    }
  }
  addComparison(comparison, "current");
  if (comparison.originalComparison) addComparison(comparison.originalComparison, "original");
  for (const [index, reading] of (comparison.retryReviews || []).entries()) {
    if (reading.completedLine) continue;
    add(`reread-${index}`, { expected: reading.signedDate, observed: reading.original, boxes: reading.boxes }, comparison, {
      reason: reading.dateField ? "Conflicting date readings" : "Conflicting readings", inspection: !reading.signedDate,
      readings: [{ label: "First reading", text: reading.original },
        { label: "Closer reading", text: reading.observed + (reading.lowConfidence ? " (uncertain)" : "") }],
      notes: ["The two readings disagree. Compare the original photo with the signed reference."],
    });
  }
  for (const [index, marking] of (comparison.markings || []).entries()) {
    add(`marking-${index}`, marking, comparison, { reason: "QRed marking", inspection: true,
      notes: ["This reading is beside a QRed code. It is not authenticated document text; inspect the original marking."],
    });
  }
  if (comparison.contrastAssisted) {
    items.push({ id: "page-contrast", reason: "Pale text and marks", inspection: true,
      difference: { boxes: [] }, notes: ["A contrast-assisted reading was needed. Inspect the whole original page for pale text or marks that it may have missed."] });
  }
  if (!items.length && comparison.status === "uncertain") {
    items.push({ id: "page-inspection", reason: "Inspect the original page", inspection: true,
      difference: { boxes: [] }, notes: ["The text check needs visual review. Compare the original page with the signed text, including pale marks and handwriting."] });
  }
  // Keep the original reading order within each group, with digits prominent.
  const priority = item => /number|date/i.test(item.reason) ? 0
    : /spacing|typography|marking|pale text/i.test(item.reason) ? 2 : 1;
  return items.sort((a, b) => priority(a) - priority(b));
}

export function currentReview(saved, page) {
  return saved && saved.comparison === page.comparison && saved.captureId === page.captureId
    && saved.reference === page.reference ? saved : { index: 0, decisions: {} };
}

export function reviewCounts(items, decisions = {}) {
  const counts = { total: items.length, reviewed: 0, matches: 0, differs: 0, unsure: 0, pending: 0 };
  for (const item of items) {
    const decision = decisions[item.id];
    if (Object.hasOwn(REVIEW_DECISIONS, decision)) { counts[decision]++; counts.reviewed++; }
    else counts.pending++;
  }
  return counts;
}

// Highlight character changes without editing either reading. Cap alignment
// work for long OCR fragments; the fallback highlights the changed middle.
export function changedCharacters(expected = "", observed = "") {
  const a = Array.from(expected), b = Array.from(observed);
  const sameA = new Set(), sameB = new Set();
  if (a.length * b.length <= 40000) {
    const columns = b.length + 1, table = new Uint16Array((a.length + 1) * columns);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
      table[i * columns + j] = a[i] === b[j] ? table[(i + 1) * columns + j + 1] + 1
        : Math.max(table[(i + 1) * columns + j], table[i * columns + j + 1]);
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { sameA.add(i++); sameB.add(j++); }
      else if (table[(i + 1) * columns + j] >= table[i * columns + j + 1]) i++;
      else j++;
    }
  } else {
    let first = 0, endA = a.length - 1, endB = b.length - 1;
    while (first < a.length && first < b.length && a[first] === b[first]) { sameA.add(first); sameB.add(first++); }
    while (endA >= first && endB >= first && a[endA] === b[endB]) { sameA.add(endA--); sameB.add(endB--); }
  }
  const parts = (chars, same) => chars.reduce((all, char, index) => {
    const changed = !same.has(index), previous = all.at(-1);
    if (previous?.changed === changed) previous.text += char;
    else all.push({ text: char, changed });
    return all;
  }, []);
  return { expected: parts(a, sameA), observed: parts(b, sameB) };
}
