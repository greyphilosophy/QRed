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

function retryFixture(initial = { text: "TotaI", confidence: 40, bbox: { x0: 100, y0: 200, x1: 200, y1: 230 } }) {
  const engine = worker(), copies = [], urls = { createObjectURL: vi.fn(() => "blob:retained-photo"), revokeObjectURL: vi.fn() };
  const pack = words => ({ data: { blocks: [{ paragraphs: [{ lines: [{ words }] }] }] } });
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

it("rereads a disputed date from enlarged contrast-adjusted pixels without supplying the signed digits to OCR", async () => {
  const bbox = { x0: 100, y0: 200, x1: 190, y1: 220 };
  const f = retryFixture({ text: "03-14-29", confidence: 51, bbox });
  const canvases = [];
  vi.stubGlobal("document", { createElement: () => {
    const context = { drawImage: vi.fn(), putImageData: vi.fn(), fillRect: vi.fn(), getImageData: (_x, _y, w, h) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = data[i + 1] = data[i + 2] = i % 16 === 0 ? 90 : 180;
        data[i + 3] = 255;
      }
      return { data };
    } };
    const canvas = { width: 0, height: 0, getContext: () => context, context };
    canvases.push(canvas);
    return canvas;
  } });
  f.engine.recognize.mockImplementationOnce(async (detail, options) => {
    expect(options).toEqual({});
    expect([detail.width, detail.height]).toEqual([328, 112]);
    return f.pack([{ text: "03-14-27", confidence: 93, bbox: { x0: 14, y0: 14, x1: 300, y1: 92 } }]);
  });
  try {
    // Use a third signed value. A confident independent reading still wins
    // and the mismatch remains visible when it differs from the signed date.
    const read = await f.reader.read(f.input, () => {}, { ...f.reference, text: "03-14-25" });
    expect(read.words[0]).toMatchObject({ text: "03-14-27", bbox });
    expect(read.retryReviews[0]).toMatchObject({ original: "03-14-29", observed: "03-14-27", signedDate: "03-14-25" });
    expect(canvases[0].context.drawImage).toHaveBeenCalledWith(f.input, 95, 196, 100, 28, 0, 0, 100, 28);
    const { data } = canvases[0].context.putImageData.mock.calls[0][0];
    expect(data[0]).toBe(79);
    expect(data[4]).toBe(255);
    expect(canvases[1].context.drawImage).toHaveBeenCalledWith(canvases[0], 14, 14, 300, 84);
    expect(f.urls.createObjectURL).not.toHaveBeenCalled();
    expect(canvases.every(c => !c.width && !c.height)).toBe(true);
    expect(f.engine.setParameters).toHaveBeenLastCalledWith({ tessedit_pageseg_mode: "3", thresholding_kfactor: "0.2" });
  } finally { f.reader.dispose(); vi.unstubAllGlobals(); }
});

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
    expect(f.engine.setParameters).toHaveBeenLastCalledWith({ tessedit_pageseg_mode: "3", thresholding_kfactor: "0.2" });
    expect(f.urls.revokeObjectURL).toHaveBeenCalledWith("blob:retained-photo");
    expect(f.decoded().src).toBe("");
    expect([...f.copies, f.prepared].every(c => c.width === 0 && c.height === 0)).toBe(true);
  } finally { f.reader.dispose(); vi.unstubAllGlobals(); }
});

it.each([true, false])("bounds a poor-page reread and retains the original when selected (%s)", async better => {
  const first = "Invoice total payable by next Friday".split(" ").map((text, i) => ({
    text, confidence: 40, bbox: { x0: 10 + i * 20, y0: 10, x1: 28 + i * 20, y1: 25 },
  }));
  const second = better ? first.map(w => ({ ...w, confidence: 96, text: w.text === "Friday" ? "Monday" : w.text })) : [first[0]];
  const pack = words => ({ data: { blocks: [{ paragraphs: [{ lines: [{ words }] }] }] } });
  const engine = worker();
  engine.recognize.mockResolvedValueOnce(pack(first)).mockResolvedValueOnce(pack(second));
  const copies = [];
  vi.stubGlobal("document", { createElement: () => {
    const copy = { width: 0, height: 0, getContext: () => Object.fromEntries(
      ["fillRect", "beginPath", "moveTo", "lineTo", "closePath", "clip", "drawImage"].map(key => [key, vi.fn()])) };
    copies.push(copy); return copy;
  } });
  const reader = createPhotoOcrReader(() => Promise.resolve(engine), () => ({ canvas: {}, codes: [],
    corners: [{x:0,y:0},{x:200,y:0},{x:200,y:100},{x:0,y:100}] }));
  try {
    const reading = await reader.read({ width: 200, height: 100 });
    expect(engine.recognize).toHaveBeenCalledTimes(2);
    expect(reading.words.map(w => w.text)).toEqual((better ? second : first).map(w => w.text));
    expect(reading.contrastAssisted).toBe(better);
    expect(reading.originalReading?.map(w => w.text)).toEqual(better ? first.map(w => w.text) : undefined);
    expect(copies.every(c => c.width === 0 && c.height === 0)).toBe(true);
    expect(engine.setParameters).toHaveBeenLastCalledWith({ thresholding_kfactor: "0.2" });
    expect(engine.recognize.mock.calls.every(([, options]) => Object.keys(options).length === 0)).toBe(true);
  } finally { reader.dispose(); vi.unstubAllGlobals(); }
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
