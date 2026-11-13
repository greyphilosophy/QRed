import { createWorker } from "tesseract.js";
import { DOCUMENT_OCR_PARAMETERS, openLocalOcrWorker, recognizedWords } from "../ocrEngine.js";
import { assignPhotoLines } from "../verifier/photoTextLayout.js";
import { OCR_REVIEW_THRESHOLD } from "../verifier/photoTextComparison.js";

const compact = text => text.normalize("NFC").replace(/\s/gu, "");

// The worker lives only for this PDF. Both the model and the image stay local.
export function createSourceOcr() {
  let worker, unavailable;
  return {
    async read(page, factory, signal) {
      signal?.throwIfAborted();
      if (unavailable) throw unavailable;
      if (!worker) {
        let nodeModel = null;
        if (import.meta.env.SSR) {
          const { createRequire } = await import("node:module");
          const { dirname } = await import("node:path");
          nodeModel = dirname(createRequire(import.meta.url).resolve("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"));
        }
        try {
          worker = await openLocalOcrWorker(createWorker, () => {}, nodeModel);
          await worker.setParameters(DOCUMENT_OCR_PARAMETERS);
        } catch (cause) {
          unavailable = new Error("The English text reader could not load.", { cause });
          unavailable.name = "SourceOcrUnavailable";
          throw unavailable;
        }
      }
      signal?.throwIfAborted();
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, Math.sqrt(5_000_000 / (base.width * base.height)));
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.floor(viewport.width)), height = Math.max(1, Math.floor(viewport.height));
      const surface = factory.create(width, height);
      const task = page.render({ canvasContext: surface.context, viewport });
      const cancelRender = () => task.cancel();
      signal?.addEventListener("abort", cancelRender, { once: true });
      try {
        await task.promise;
        signal?.throwIfAborted();
        const input = import.meta.env.SSR ? surface.canvas.toBuffer("image/png") : surface.canvas;
        const { data } = await worker.recognize(input, {}, { blocks: true });
        signal?.throwIfAborted();
        return recognizedWords(data, 1).map(word => ({ ...word, bbox: {
          x0: word.bbox.x0 / width, x1: word.bbox.x1 / width, y0: word.bbox.y0 / height, y1: word.bbox.y1 / height,
        } }));
      } finally {
        signal?.removeEventListener("abort", cancelRender);
        factory.destroy(surface);
      }
    },
    async close() { if (worker) await worker.terminate(); },
  };
}

function lineGeometry(text, box) {
  const { x: x0, y: y0, width, height } = box, x1 = x0 + width, y1 = y0 + height;
  return { text, bbox: { x0, y0, x1, y1 }, polygon: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] };
}

// Exact OCR readings can be recorded for a localized, mostly legible source
// line. Completely different strings and missing lines provide no alternate.
function similarReading(expected, observed) {
  const a = compact(expected), b = compact(observed);
  if (!a || !b || a === b || Math.max(a.length, b.length) > 192 ||
      observed.length > 256 || /[\p{Cc}]/u.test(observed)) return false;
  const limit = Math.min(8, Math.max(1, Math.floor(Math.max(a.length, b.length) / 4)));
  if (Math.abs(a.length - b.length) > limit) return false;
  let previous = Uint16Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const row = new Uint16Array(b.length + 1); row[0] = i + 1;
    for (let j = 0; j < b.length; j++)
      row[j + 1] = Math.min(row[j] + 1, previous[j + 1] + 1, previous[j] + Number(a[i] !== b[j]));
    previous = row;
  }
  return previous[b.length] <= limit;
}

export function addSourceReadings(text, lines, words) {
  const rows = text.split("\n"), nonempty = rows.filter(line => line.trim());
  if (nonempty.length !== lines.length) return { text, lines };
  const native = nonempty.map((line, i) => lineGeometry(line, lines[i]));
  const assigned = assignPhotoLines(native, words), covered = new Set(), variants = new Map();
  assigned.forEach((line, i) => {
    for (const index of line.wordIndices) covered.add(index);
    const observed = line.wordIndices.map(index => words[index].text).join(" ").trim();
    if (similarReading(line.text, observed)) variants.set(i, observed);
  });

  // Keep the native line breaks and order. Insert only independently read
  // lettering with no underlying PDF text at those coordinates.
  const additions = [], groups = new Map();
  for (const [index, word] of words.entries()) {
    const { bbox: b } = word;
    // Exclude any partial overlap too: a native word protruding from its
    // nominal PDF line box must not be signed a second time as artwork.
    const overlaps = covered.has(index) || native.some(({ bbox: a }) =>
      Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0));
    if (!groups.has(word.lineId)) groups.set(word.lineId, []);
    groups.get(word.lineId).push(overlaps ? null : word);
  }
  const finish = group => {
    if (!group.length || group.some(w => !(w.confidence >= OCR_REVIEW_THRESHOLD))) return;
    const content = group.map(w => w.text).join(" ").trim();
    if (!/[\p{L}\p{N}]{2}/u.test(content) || /[\p{Cc}]/u.test(content)) return;
    let x = 1, y = 1, right = 0, bottom = 0;
    for (const { bbox } of group) {
      x = Math.min(x, bbox.x0); y = Math.min(y, bbox.y0);
      right = Math.max(right, bbox.x1); bottom = Math.max(bottom, bbox.y1);
    }
    const width = right - x, height = bottom - y;
    if (width > 0 && height > 0) additions.push({ content, box: { x, y, width, height } });
  };
  for (const group of groups.values()) {
    let fragment = [];
    for (const word of group) {
      if (word) fragment.push(word);
      else { finish(fragment); fragment = []; }
    }
    finish(fragment);
  }
  additions.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const inserts = Array.from({ length: lines.length + 1 }, () => []);
  for (const a of additions) {
    const where = lines.findIndex(b => a.box.y + a.box.height / 2 < b.y ||
      (Math.abs(a.box.y - b.y) < Math.min(a.box.height, b.height) / 2 && a.box.x + a.box.width <= b.x));
    inserts[where < 0 ? lines.length : where].push(a);
  }
  const output = [], boxes = [], ocrReadings = [];
  let i = 0;
  const insert = group => { for (const a of group) { output.push(a.content); boxes.push(a.box); } };
  for (const row of rows) {
    if (!row.trim()) { if (text) output.push(row); continue; }
    insert(inserts[i]);
    if (variants.has(i)) ocrReadings.push({ line: boxes.length, observed: variants.get(i) });
    output.push(row); boxes.push(lines[i++]);
  }
  insert(inserts[i]);
  return { text: output.join("\n"), lines: boxes, ocrReadings };
}
