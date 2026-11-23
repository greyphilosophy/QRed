import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { createWorker } from "tesseract.js";
import { expect, it, vi } from "vitest";
import { createPhotoOcrReader } from "./photoOcr.js";
import { comparePageReading } from "./photoReading.js";
import { recognizedWords } from "../ocrEngine.js";
import { applyDateColumn } from "./photoDateTable.js";

it("rereads a dated column from its pixels, keeping changed, missing and extra ink", async () => {
  const width = 850, height = 650, canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ddd"; ctx.fillRect(0, 0, width, height);
  ctx.font = "24px DejaVu Sans";
  // The gray heading is enclosed by rules which can merge with its short word.
  ctx.fillStyle = "#666"; ctx.fillRect(64, 58, 200, 2); ctx.fillRect(64, 101, 200, 2);
  ctx.fillStyle = "#282828";
  const expected = ["Date", ...Array(3).fill("04-13-27"), ...Array(5).fill("04-14-27")];
  const printed = ["Date", "04-13-27", "04-13-27", "04-13-27", "04-14-27", "04-14-29", "", "04-14-30", "VOID"];
  const first = ["3", "04-13-27", "04-13-27", "04-13-", "1", "1", "", "04-14-27", ""];
  const lines = [], initial = [], signed = [];
  const word = (text, x, y, w, confidence = 96) =>
    ({ text, confidence, bbox: { x0: x, y0: y, x1: x + w, y1: y + 24 } });
  for (let i = 0; i < expected.length; i++) {
    const y = 70 + i * 55, label = i ? "Transaction" : "Description";
    ctx.fillText(printed[i], 85, y + 22); ctx.fillText(label, 290, y + 22);
    if (i === 0 || i === 3) {
      const left = printed[i].slice(0, 1), right = printed[i].slice(1);
      initial.push(word(left, 85, y, ctx.measureText(left).width),
        word(right, 85 + ctx.measureText(left).width, y, ctx.measureText(right).width));
    } else if (first[i]) initial.push(word(first[i], 85, y, ctx.measureText(first[i]).width, 92));
    initial.push(word(label, 290, y, 145));
    signed.push(expected[i] + " " + label);
    lines.push({ x: 80 / width, y: (y - 2) / height, width: 380 / width, height: 30 / height });
  }
  ctx.fillText("Added", 495, 260);
  initial.push(word("Added", 495, 238, 65));
  const text = signed.join("\n");
  const corners = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
  const evidence = { width, height, text, layout: { mode: 3, lines } };
  const model = dirname(createRequire(import.meta.url).resolve("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"));
  const real = await createWorker("eng", 1, { langPath: model, cacheMethod: "none" });
  const recognize = real.recognize.bind(real);
  let reads = 0;
  // Replay the first pass's omissions, then let the bundled engine read the crops.
  real.recognize = (input, options, output) => {
    expect(options).toEqual({});
    return reads++ === 0 ? { data: { blocks: [{ paragraphs: [{ lines: [{ words: initial }] }] }] } }
      : recognize(input.toBuffer("image/png"), options, output);
  };
  vi.stubGlobal("document", { createElement: () => createCanvas(1, 1) });
  const reader = createPhotoOcrReader(async () => real, async () => ({ codes: [], corners, canvas: createCanvas(1, 1) }));
  try {
    const reading = await reader.read(canvas, () => {}, { text, evidence });
    const comparison = comparePageReading(text, reading, canvas, evidence);
    expect(comparison.differences.filter(d => ["Date", "04-13-27"].includes(d.expected))).toEqual([]);
    expect(comparison.differences.filter(d => d.expected === "04-14-27").map(d => d.observed).sort())
      .toEqual(["", "04-14-29", "VOID"]);
    expect(comparison.differences.some(d => d.observed === "Added")).toBe(true);
    expect(reading.retryReviews).toEqual([expect.objectContaining({ original: "04-14-27", observed: "04-14-30" })]);
  } finally { reader.dispose(); vi.unstubAllGlobals(); }
}, 20000);

it("reconciles sideways segmentation only when every glyph is accounted for across read rows", () => {
  const rows = [100, 150, 200].map(y => ({ expected: "04-15-27", row: {
    polygon: [{ x: 20, y }, { x: 200, y }, { x: 200, y: y + 30 }, { x: 20, y: y + 30 }],
  } }));
  const plan = { fields: rows, box: { x0: 10, x1: 160, y0: 90, y1: 240 } };
  const reread = [100, 150, 200].map(y => ({ text: "04-15-27", confidence: 95,
    bbox: { x0: 20, x1: 143, y0: y + 4, y1: y + 27 } }));
  const pageHeight = 400;
  const sideways = (text, x, tops) => ({ text, confidence: 45,
    bbox: { x0: x, x1: x + 12, y0: Math.min(...tops), y1: Math.max(...tops) + 12 },
    // The pinned engine expresses symbol extents along the rotated line.
    symbols: tops.map(y => ({ bbox: { x0: pageHeight - y - 12, x1: pageHeight - y, y0: pageHeight, y1: pageHeight } })),
  });
  const engine = [sideways("NNN", 60, [105, 155, 205]), sideways("EXTRA", 79, [106, 132, 156, 181, 206])];
  const first = recognizedWords({ blocks: [{ paragraphs: [{ lines: [{ words: engine }] }] }] }, 1, pageHeight);
  const result = applyDateColumn(first, plan, reread);
  expect(result.words.map(w => w.text).sort()).toEqual(["04-15-27", "04-15-27", "04-15-27", "EXTRA"]);
});
