import { expect, it, vi } from "vitest";
import { createPhotoOcrReader as createReader } from "./photoOcr.js";
const createPhotoOcrReader = (factory, prepareImage) => createReader(factory, prepareImage, null);

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
  expect((await reader.read(image)).words).toEqual([{ text: "Read", confidence: 96, bbox: { x0: 1, x1: 20, y0: 2, y1: 15 }, lineId: "1:0:0:0" }]);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledWith("eng", 1, expect.objectContaining({
    workerPath: "/ocr/v1/worker.min.js", corePath: "/ocr/v1", langPath: "/ocr/v1", cacheMethod: "none",
  }));
  expect(engine.setParameters).toHaveBeenCalledWith({ tessedit_pageseg_mode: "3", thresholding_method: "2", thresholding_kfactor: "0.2" });
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

it("aborts concurrent preparation and releases a copy delivered after the reader is disposed", async () => {
  let finishPreparation, signal;
  const engine = worker(), copy = { width: 100, height: 200 };
  const reader = createPhotoOcrReader(() => Promise.resolve(engine), (_, options) => {
    signal = options.signal;
    return new Promise(resolve => { finishPreparation = resolve; });
  });
  const read = reader.read({ width: 100, height: 200 });
  await vi.waitFor(() => expect(finishPreparation).toBeTypeOf("function"));
  reader.dispose();
  expect(signal.aborted).toBe(true);
  finishPreparation({ canvas: copy, codes: [] });
  await expect(read).rejects.toMatchObject({ name: "AbortError" });
  expect(copy).toEqual({ width: 0, height: 0 });
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

it("reports first-pass recognition progress without restarting it for a recovery pass", async () => {
  let logger;
  const engine = worker(), progress = vi.fn();
  engine.recognize.mockImplementationOnce(async () => {
    logger({ status: "recognizing text", progress: .03 });
    return { data: { blocks: [] } };
  }).mockImplementationOnce(async () => {
    logger({ status: "recognizing text", progress: .1 });
    return { data: { blocks: [] } };
  });
  const reader = createPhotoOcrReader((...args) => {
    logger = args[2].logger;
    return Promise.resolve(engine);
  }, () => ({ canvas: {}, codes: [] }));
  await reader.read({ width: 100, height: 200 }, progress);
  expect(progress.mock.calls.map(([event]) => event)).toEqual([
    { status: "recognizing text", progress: .03 }, { status: "processing" }, { status: "processing" },
  ]);
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

function retryFixture() {
  const engine = worker(), copies = [], urls = { createObjectURL: vi.fn(() => "blob:retained-photo"), revokeObjectURL: vi.fn() };
  const pack = words => ({ data: { blocks: [{ paragraphs: [{ lines: [{ words }] }] }] } });
  const initial = { text: "TotaI", confidence: 40, bbox: { x0: 100, y0: 200, x1: 200, y1: 230 } };
  engine.recognize.mockResolvedValueOnce(pack([initial]));
  let decoded;
  vi.stubGlobal("URL", urls);
  vi.stubGlobal("Image", class {
    naturalWidth = 2000; naturalHeight = 2800;
    constructor() { decoded = this; }
    decode() { return Promise.resolve(); }
  });
  vi.stubGlobal("document", { createElement: () => {
    const drawImage = vi.fn(), canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), drawImage };
    copies.push(canvas); return canvas;
  } });
  const prepared = { width: 1000, height: 1400 };
  const reader = createPhotoOcrReader(() => Promise.resolve(engine), () => ({ canvas: prepared, codes: [] }));
  return { engine, pack, initial, copies, urls, prepared, reader, decoded: () => decoded,
    input: { width: 1000, height: 1400 }, reference: { text: "Total", file: { type: "image/png", size: 1000 } } };
}

it("rereads native-resolution pixels independently, maps the crop back, and releases every temporary image", async () => {
  const f = retryFixture();
  f.engine.recognize.mockImplementationOnce(async image => f.pack([{ text: "Total", confidence: 96,
    bbox: { x0: image.width / 4, y0: image.height / 4, x1: image.width * .75, y1: image.height * .75 } }]));
  try {
    const result = await f.reader.read(f.input, () => {}, f.reference);
    expect(result.words[0]).toMatchObject({ text: "Total", confidence: 96,
      bbox: { x0: 122.5, y0: 205, x1: 177.5, y1: 225 } });
    expect(result.retryReviews).toEqual([expect.objectContaining({ original: "TotaI", observed: "Total" })]);
    expect(f.copies[0].drawImage).toHaveBeenCalledWith(f.decoded(), 190, 390, 220, 80, 0, 0, 220, 80);
    expect(f.engine.recognize.mock.calls.every(([, options, output]) =>
      Object.keys(options).length === 0 && output.text === true && output.blocks === true)).toBe(true);
    expect(f.engine.setParameters).toHaveBeenLastCalledWith({ tessedit_pageseg_mode: "3" });
    expect(f.urls.revokeObjectURL).toHaveBeenCalledWith("blob:retained-photo");
    expect(f.decoded().src).toBe("");
    expect([...f.copies, f.prepared].every(c => c.width === 0 && c.height === 0)).toBe(true);
  } finally { f.reader.dispose(); vi.unstubAllGlobals(); }
});

it("cancels an in-flight retry without publishing it or retaining its original-resolution image", async () => {
  const f = retryFixture();
  let finish;
  f.engine.recognize.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  try {
    const reading = f.reader.read(f.input, () => {}, f.reference);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    f.reader.dispose();
    finish(f.pack([{ ...f.initial, text: "Total", confidence: 96 }]));
    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(f.engine.terminate).toHaveBeenCalledTimes(1);
    expect(f.urls.revokeObjectURL).toHaveBeenCalledWith("blob:retained-photo");
    expect(f.decoded().src).toBe("");
    expect([...f.copies, f.prepared].every(c => c.width === 0 && c.height === 0)).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});

it("prepares both same-origin models and releases both after a failed secondary load", async () => {
  const primary = worker(), alternate = worker(), factory = vi.fn().mockResolvedValue(primary);
  const secondaryFactory = vi.fn().mockRejectedValueOnce(new Error("Missing alternate model")).mockResolvedValue(alternate);
  const reader = createReader(factory, () => ({ canvas: {}, codes: [] }), secondaryFactory);
  await expect(reader.prepare()).rejects.toThrow("Missing alternate model");
  expect(primary.terminate).toHaveBeenCalledTimes(1);
  await reader.prepare();
  expect(secondaryFactory).toHaveBeenLastCalledWith("eng", 0, expect.objectContaining({
    workerPath: "/ocr/v1/worker.min.js", corePath: "/ocr/v1", langPath: "/ocr/v1/legacy", cacheMethod: "none",
  }));
  expect(alternate.setParameters).toHaveBeenCalledWith({ tessedit_pageseg_mode: "7", thresholding_method: "0" });
  reader.dispose();
  expect(alternate.terminate).toHaveBeenCalledTimes(1);
});
it("terminates a secondary worker that initializes after cancellation", async () => {
  const primary = worker(), alternate = worker();
  let finish;
  const reader = createReader(() => Promise.resolve(primary), () => ({ canvas: {}, codes: [] }),
    () => new Promise(resolve => { finish = resolve; }));
  const preparing = reader.prepare();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  reader.dispose(); finish(alternate);
  await expect(preparing).rejects.toThrow(/cancelled/);
  expect(alternate.terminate).toHaveBeenCalledTimes(1);
  expect(primary.terminate).toHaveBeenCalledTimes(1);
});

async function alternateFixture(expected, observed = "Total", { outside = false, partial = false } = {}) {
  const primary = worker(), alternate = worker(), copies = [];
  const pack = words => ({ data: { blocks: [{ paragraphs: [{ lines: [{ words }] }] }] } });
  const initial = { text: "TotaI", confidence: 40, bbox: { x0: 100, y0: 200, x1: 200, y1: 230 } };
  primary.recognize.mockResolvedValue(pack([initial]));
  alternate.recognize.mockImplementation(async canvas => pack([{ text: observed, confidence: 96,
    bbox: partial ? { x0: 30 } : { x0: outside ? 0 : 30, y0: 30, x1: canvas.width - 30, y1: canvas.height - 30 } }]));
  vi.stubGlobal("document", { createElement: () => {
    const drawImage = vi.fn(), fillRect = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage, fillRect }), drawImage, fillRect };
    copies.push(canvas); return canvas;
  } });
  const reader = createReader(() => Promise.resolve(primary), () => ({ canvas: {}, codes: [] }), () => Promise.resolve(alternate));
  try {
    const result = await reader.read({ width: 1000, height: 1400 }, () => {}, { text: expected });
    return { result, calls: alternate.recognize.mock.calls, copies };
  } finally { reader.dispose(); vi.unstubAllGlobals(); }
}
it("selects the same alternate reading for identical pixels regardless of signed text", async () => {
  const first = await alternateFixture("Total"), changedReference = await alternateFixture("Other");
  expect(first.result.words.map(word => word.text)).toEqual(["Total"]);
  expect(changedReference.result.words).toEqual(first.result.words);
  expect(first.result.retryReviews).toEqual([expect.objectContaining({ original: "TotaI", observed: "Total" })]);
  expect(first.calls).toHaveLength(1);
  expect(first.calls[0].slice(1)).toEqual([{}, { text: true, blocks: true }]);
  expect(first.copies[1].drawImage).toHaveBeenCalledWith(expect.any(Object), 95, 195, 110, 40, 20, 20, 220, 80);
  expect(first.copies.every(canvas => canvas.width === 0 && canvas.height === 0)).toBe(true);
});
it("does not correct an altered amount or deleted punctuation to the signed reference", async () => {
  const { comparePageReading } = await import("./photoReading.js");
  for (const [expected, observed] of [["100", "900"], ["Label:", "Label"], ["I agree", "| agree"], ["1 of 2", "9 of 2"]]) {
    const { result } = await alternateFixture(expected, observed);
    expect(result.words[0].text).toBe(observed);
    expect(comparePageReading(expected, result, { width: 1000, height: 1400 }).status).toBe("differences");
    expect(result.retryReviews.length).toBeGreaterThan(0);
  }
});

it.each([{ outside: true }, { partial: true }])("rejects an alternate transcript with invalid crop geometry %j", async geometry => {
  const { result } = await alternateFixture("Total", "Total", geometry);
  expect(result.words[0].text).toBe("TotaI");
  expect(result.retryReviews).toEqual([]);
});
it("does not let a cancelled read's late rejection dispose a newer session", async () => {
  const old = worker(), next = worker();
  let rejectOld, finishNew;
  old.recognize.mockImplementation(() => new Promise((_, reject) => { rejectOld = reject; }));
  next.recognize.mockImplementation(() => new Promise(resolve => { finishNew = resolve; }));
  const factory = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(next);
  const reader = createReader(factory, () => ({ canvas: {}, codes: [] }), null);
  const first = reader.read({ width: 100, height: 200 });
  const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(rejectOld).toBeTypeOf("function"));
  reader.dispose();
  const second = reader.read({ width: 100, height: 200 });
  await vi.waitFor(() => expect(finishNew).toBeTypeOf("function"));
  rejectOld(new Error("Old worker stopped"));
  await cancelled;
  expect(next.terminate).not.toHaveBeenCalled();
  finishNew({ data: { blocks: [] } });
  // Empty first pass causes a contrast read, which uses the same worker.
  next.recognize.mockResolvedValue({ data: { blocks: [] } });
  await expect(second).resolves.toMatchObject({ words: [] });
  reader.dispose();
});
it("shares the crop pixel budget across both engines", async () => {
  const { TEXT_RETRY_PIXELS } = await import("./photoOcrRetry.js");
  const pack = words => ({ data: { blocks: [{ paragraphs: [{ lines: words.map(word => ({ words: [word] })) }] }] } });
  const initial = Array.from({ length: 12 }, (_, i) => ({ text: `row${i}`, confidence: 20,
    bbox: { x0: 20, y0: 50 + i * 130, x1: 920, y1: 120 + i * 130 } }));
  const primary = worker(), alternate = worker(), sizes = [];
  primary.recognize.mockResolvedValueOnce(pack(initial)).mockImplementation(async canvas => {
    sizes.push(canvas.width * canvas.height); return pack([]);
  });
  alternate.recognize.mockImplementation(async canvas => { sizes.push(canvas.width * canvas.height); return pack([]); });
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ drawImage: vi.fn(), fillRect: vi.fn() }) }) });
  const reader = createReader(() => Promise.resolve(primary), () => ({ canvas: {}, codes: [] }), () => Promise.resolve(alternate));
  try {
    await reader.read({ width: 1000, height: 2000 }, () => {}, { text: "Independent reference" });
    expect(alternate.recognize).toHaveBeenCalled();
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(TEXT_RETRY_PIXELS);
    expect(sizes.length).toBeLessThan(24);
  } finally { reader.dispose(); vi.unstubAllGlobals(); }
});
