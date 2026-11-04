import { createWorker } from "tesseract.js";

export const SEALING_OCR_ENGINE = "tesseract-eng-v1";

async function workerOptions() {
  if (import.meta.env.SSR) {
    const { createRequire } = await import("node:module");
    const { dirname, join } = await import("node:path");
    const require = createRequire(import.meta.url);
    return { langPath: join(dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int") };
  }
  return { workerPath: "/ocr/v1/worker.min.js", corePath: "/ocr/v1", langPath: "/ocr/v1", workerBlobURL: false };
}

// No signed/native text is supplied to the recognizer. All returned lines,
// including weak or contradictory readings, are retained as machine evidence.
export function sealingOcrLines(data, width, height) {
  const lines = [];
  for (const block of data.blocks || []) for (const paragraph of block.paragraphs || []) {
    for (const line of paragraph.lines || []) {
      const text = String(line.text || "").normalize("NFC").trim().replace(/\r?\n/g, " ");
      if (!text) continue;
      const box = line.bbox;
      if (!box || ![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite) ||
          box.x0 < 0 || box.y0 < 0 || box.x1 > width || box.y1 > height || box.x1 <= box.x0 || box.y1 <= box.y0) {
        throw new Error("Text recognition returned an invalid line position. Retry this PDF.");
      }
      const confidences = (line.words || []).map(word => word.confidence).filter(Number.isFinite);
      const confidence = confidences.length ? Math.min(...confidences) : line.confidence;
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) throw new Error("Text recognition returned invalid confidence.");
      lines.push({ text, x: box.x0 / width, y: box.y0 / height,
        width: (box.x1 - box.x0) / width, height: (box.y1 - box.y0) / height,
        confidence: Math.floor(confidence) });
    }
  }
  // Never silently discard a transcript if the engine omitted its geometry.
  const normalized = value => String(value || "").normalize("NFC").replace(/\s+/gu, " ").trim();
  if (normalized(data.text) && normalized(data.text) !== normalized(lines.map(line => line.text).join("\n"))) {
    throw new Error("Text recognition did not return complete line positions. Retry this PDF.");
  }
  return lines;
}

export function createSealingOcrReader({ signal, onProgress = () => {}, workerFactory = createWorker } = {}) {
  let worker, pending, disposed = false;
  const abort = () => { disposed = true; void worker?.terminate(); worker = null; };
  signal?.addEventListener("abort", abort, { once: true });
  const check = () => {
    signal?.throwIfAborted();
    if (disposed) throw new DOMException("PDF text recognition cancelled", "AbortError");
  };
  const wait = async promise => {
    check();
    if (!signal) return promise;
    let listener;
    const cancelled = new Promise((_, reject) => {
      listener = () => reject(signal.reason || new DOMException("PDF text recognition cancelled", "AbortError"));
      signal.addEventListener("abort", listener, { once: true });
    });
    try { return await Promise.race([promise, cancelled]); }
    finally { signal.removeEventListener("abort", listener); }
  };
  return {
    async read(image, width, height) {
      check();
      if (!pending) pending = (async () => {
        const options = await workerOptions();
        check();
        const next = await workerFactory("eng", 1, { ...options, cacheMethod: "none",
          logger: event => { if (!disposed) onProgress(event); }, errorHandler: () => {} });
        if (disposed || signal?.aborted) { await next.terminate(); check(); }
        worker = next;
        await next.setParameters({ tessedit_pageseg_mode: "3" });
        return next;
      })();
      const current = await wait(pending);
      check();
      // Worker termination does not promise to reject an in-flight recognize
      // promise. Race the abort signal so the UI can finish cancellation.
      const { data } = await wait(current.recognize(image, {}, { text: true, blocks: true }));
      check();
      return { engine: SEALING_OCR_ENGINE, lines: sealingOcrLines(data, width, height) };
    },
    async dispose() {
      signal?.removeEventListener("abort", abort);
      disposed = true;
      if (worker) { const current = worker; worker = null; await current.terminate(); }
    },
  };
}
