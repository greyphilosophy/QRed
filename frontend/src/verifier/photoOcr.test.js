import { expect, it, vi } from "vitest";
import { createPhotoOcrReader } from "./photoOcr.js";

function worker() {
  return { setParameters: vi.fn().mockResolvedValue(), terminate: vi.fn().mockResolvedValue(),
    recognize: vi.fn().mockResolvedValue({ data: { blocks: [{ paragraphs: [{ lines: [{ words: [
      { text: "Read", confidence: 96, bbox: { x0: 1, x1: 20, y0: 2, y1: 15 }, extraEngineState: true },
    ] }] }] }] } }) };
}
it("uses only local versioned assets and extracts bounded word data from the real engine output format", async () => {
  const engine = worker(), factory = vi.fn().mockResolvedValue(engine);
  const reader = createPhotoOcrReader(factory, () => ({ canvas: {}, codes: [] }));
  await reader.prepare();
  const image = { width: 30, height: 20 };
  expect((await reader.read(image)).words).toEqual([{ text: "Read", confidence: 96, bbox: { x0: 1, x1: 20, y0: 2, y1: 15 } }]);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledWith("eng", 1, expect.objectContaining({
    workerPath: "/ocr/v1/worker.min.js", corePath: "/ocr/v1", langPath: "/ocr/v1", cacheMethod: "none",
  }));
  expect(engine.recognize).toHaveBeenCalledWith(image, {}, { text: true, blocks: true });
  reader.dispose();
  expect(engine.terminate).toHaveBeenCalledTimes(1);
});
it("terminates a worker which finishes loading after cancellation", async () => {
  let resolve;
  const engine = worker(), reader = createPhotoOcrReader(() => new Promise(done => { resolve = done; }));
  const loading = reader.prepare();
  reader.dispose();
  resolve(engine);
  await expect(loading).rejects.toThrow(/cancelled/);
  expect(engine.terminate).toHaveBeenCalledTimes(1);
});
it("retries initialization after a failed load", async () => {
  const factory = vi.fn().mockRejectedValueOnce(new Error("Missing language")).mockResolvedValue(worker());
  const reader = createPhotoOcrReader(factory, () => ({ canvas: {}, codes: [] }));
  await expect(reader.prepare()).rejects.toThrow("Missing language");
  await reader.prepare();
  expect(factory).toHaveBeenCalledTimes(2);
  reader.dispose();
});
it("labels the contrast fallback and releases its pixels after recognition", async () => {
  const engine = worker();
  engine.recognize.mockResolvedValueOnce({ data: { blocks: [] } });
  const copy = { width: 100, height: 200 };
  const reader = createPhotoOcrReader(() => Promise.resolve(engine), () => ({ canvas: copy, codes: [] }));
  const result = await reader.read({ width: 100, height: 200 });
  expect(result.contrastAssisted).toBe(true);
  expect(result.words[0].text).toBe("Read");
  expect(engine.recognize).toHaveBeenCalledTimes(2);
  expect(copy).toEqual({ width: 0, height: 0 });
  reader.dispose();
});
it("preserves readings from the original instead of replacing them with a cleaner-looking copy", async () => {
  const engine = worker(), copy = { width: 100, height: 200 };
  const reader = createPhotoOcrReader(() => Promise.resolve(engine), () => ({ canvas: copy, codes: [] }));
  const result = await reader.read({ width: 100, height: 200 });
  expect(result.contrastAssisted).toBe(false);
  expect(engine.recognize).toHaveBeenCalledTimes(1);
  expect(copy.width).toBe(0);
  reader.dispose();
});
it("independently enlarges a misread caption while preserving a nearby added word", async () => {
  const word = (text, x0, y0, x1) => ({ text, confidence: 95, bbox: { x0, y0, x1, y1: y0 + 12 } });
  const pack = words => ({ data: { blocks: [{ paragraphs: [{ lines: [{ words }] }] }] } });
  const original = [word("Friday", 10, 10, 60), word(">", 170, 280, 180), word("2", 90, 280, 100), word("Paid", 190, 280, 210)];
  const caption = [word("Verify", 16, 16, 76), word("at", 86, 16, 106), word("qred.org", 116, 16, 196)];
  const engine = worker();
  engine.recognize.mockResolvedValueOnce(pack(original)).mockResolvedValueOnce(pack(caption));
  const copies = [];
  vi.stubGlobal("document", { createElement: () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }) };
    copies.push(canvas); return canvas;
  } });
  const reader = createPhotoOcrReader(() => Promise.resolve(engine), () => ({ canvas: {},
    codes: [{ x0: 100, y0: 200, x1: 160, y1: 260 }] }));
  try {
    const result = await reader.read({ width: 600, height: 800 });
    expect(result.words.map(word => word.text)).toEqual(["Friday", "Verify", "at", "qred.org", "Paid"]);
    expect(result.words[1].bbox.x0).toBe(90);
    expect(engine.recognize).toHaveBeenCalledTimes(2);
    expect(engine.setParameters).toHaveBeenLastCalledWith({ tessedit_pageseg_mode: "3" });
    expect(copies.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
  } finally { reader.dispose(); vi.unstubAllGlobals(); }
});
