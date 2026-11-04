import { sealedTextReference } from "./sealedTextReference.js";
import { createWorker } from "tesseract.js";
import { captionLineCandidates, comparePageReading, isPrintedCaption, preparePhotoReading } from "./photoReading.js";
import { OCR_REVIEW_THRESHOLD } from "./photoTextComparison.js";
import { signedPhotoLines } from "./photoTextLayout.js";
import { applyTextRetries, planTextRetries, preferTextRetry, TEXT_RETRY_MS, TEXT_RETRY_PIXELS } from "./photoOcrRetry.js";

// These versioned resources are copied from locked dependencies at build time.
// Never use Tesseract's default CDN paths: all resources belong to this origin.
export const OCR_ASSET_PATH = "/ocr/v1";

export function createPhotoOcrReader(workerFactory = createWorker, prepareImage = preparePhotoReading, secondaryFactory = workerFactory) {
  let worker = null, pending = null, generation = 0;
  let secondary = null, secondaryPending = null;
  let preprocessing = null;
  let progress = () => {};

  async function prepare(onProgress = () => {}) {
    progress = onProgress;
    if (worker) return worker;
    if (!pending) {
      const epoch = generation;
      pending = workerFactory("eng", 1, {
        workerPath: `${OCR_ASSET_PATH}/worker.min.js`,
        corePath: OCR_ASSET_PATH,
        langPath: OCR_ASSET_PATH,
        workerBlobURL: false,
        cacheMethod: "none", // No separate persistent OCR/document storage.
        logger: event => { if (epoch === generation) progress(event); },
        errorHandler: () => {}, // Errors reject the API promise; don't also throw globally.
      }).then(async next => {
        if (epoch !== generation) { await next.terminate(); throw new Error("Reading cancelled."); }
        worker = next;
        // A pale watermark can dominate a page-wide threshold and turn the
        // background into letters. Local adaptive thresholding reads the
        // original pixels, including faint additions, without a second pass.
        // A less aggressive factor retains light-gray additions that the
        // engine's default Sauvola factor can discard beside a watermark.
        await next.setParameters({ tessedit_pageseg_mode: "3", thresholding_method: "2", thresholding_kfactor: "0.2" });
        if (epoch !== generation) throw new Error("Reading cancelled.");
        return next;
      }).catch(error => {
        if (epoch === generation) { pending = null; worker?.terminate(); worker = null; }
        throw error;
      });
    }
    return pending;
  }

  async function prepareSecondary() {
    if (!secondaryFactory) return null;
    if (secondary) return secondary;
    if (!secondaryPending) {
      const epoch = generation;
      secondaryPending = secondaryFactory("eng", 0, {
        workerPath: `${OCR_ASSET_PATH}/worker.min.js`, corePath: OCR_ASSET_PATH,
        langPath: `${OCR_ASSET_PATH}/legacy`, workerBlobURL: false, cacheMethod: "none", errorHandler: () => {},
      }).then(async next => {
        if (epoch !== generation) { await next.terminate(); throw new Error("Reading cancelled."); }
        secondary = next;
        await next.setParameters({ tessedit_pageseg_mode: "7", thresholding_method: "0" });
        if (epoch !== generation) throw new Error("Reading cancelled.");
        return next;
      }).catch(error => {
        if (epoch === generation) { secondaryPending = null; secondary?.terminate(); secondary = null; }
        throw error;
      });
    }
    return secondaryPending;
  }

  function dispose() {
    generation += 1;
    progress = () => {};
    preprocessing?.abort(); preprocessing = null;
    worker?.terminate(); worker = null; pending = null;
    secondary?.terminate(); secondary = null; secondaryPending = null;
  }

  return {
    // Offline preparation loads both independent engines and their local models.
    async prepare(onProgress) {
      const epoch = generation;
      try {
        await prepare(onProgress);
        if (epoch !== generation) throw new Error("Reading cancelled.");
        await prepareSecondary();
      }
      catch (error) { if (epoch === generation) dispose(); throw error; }
    },
    async read(canvas, onProgress = () => {}, reference = {}) {
      const readEpoch = generation, controller = new AbortController();
      preprocessing = controller;
      let pass = 0, current;
      try {
        current = await abortable(prepare(event => {
          // Only the first whole-page reading has a useful percentage.
          if (pass === 1) onProgress(event);
        }), controller.signal);
      } catch (error) {
        if (readEpoch === generation) dispose();
        throw error;
      }
      // The signed text is deliberately never supplied to the recognition engine.
      const recognize = async (image, engine = current) => {
        controller.signal.throwIfAborted();
        pass++;
        const { data } = await abortable(engine.recognize(image, {}, { text: true, blocks: true }), controller.signal);
        controller.signal.throwIfAborted();
        onProgress({ status: "processing" });
        return (data.blocks || []).flatMap((block, b) => (block.paragraphs || [])
          .flatMap((paragraph, p) => (paragraph.lines || []).flatMap((line, l) => (line.words || [])
            .map(({ text, confidence, bbox }) => ({ text, confidence, bbox, lineId: `${pass}:${b}:${p}:${l}` })))));
      };
      let prepared;
      try {
        // OCR and bounded image preparation use separate workers. Neither QR
        // searching nor contrast processing may block input and cancellation.
        const preparation = Promise.resolve().then(() => prepareImage(canvas, { signal: controller.signal })).then(result => {
          if (controller.signal.aborted) {
            if (result.canvas) result.canvas.width = result.canvas.height = 0;
            throw new DOMException("Reading cancelled", "AbortError");
          }
          prepared = result;
        });
        let [words] = await Promise.all([recognize(canvas), preparation]);
        if (controller.signal.aborted) throw new DOMException("Reading cancelled", "AbortError");
        // Preserve every reading from the original. Only use the contrast copy
        // when segmentation found no text at all, and label its limitations.
        const contrastAssisted = words.length === 0;
        if (contrastAssisted) words = await recognize(prepared.canvas);
        const candidates = captionLineCandidates(words, prepared.codes);
        if (candidates.length) {
          const removed = new Set(), replacements = new Map();
          await current.setParameters({ tessedit_pageseg_mode: "7" });
          try {
            for (const line of candidates) {
              const left = Math.max(0, Math.floor(line.x0) - 8), top = Math.max(0, Math.floor(line.y0) - 8);
              const width = Math.min(canvas.width - left, Math.ceil(line.x1) - left + 8);
              const height = Math.min(canvas.height - top, Math.ceil(line.y1) - top + 8);
              if (width * height > 250000) continue;
              const detail = document.createElement("canvas");
              detail.width = width * 2; detail.height = height * 2;
              try {
                detail.getContext("2d").drawImage(canvas, left, top, width, height, 0, 0, detail.width, detail.height);
                const caption = await recognize(detail);
                if (!isPrintedCaption(caption)) continue;
                const mapped = caption.map(word => ({ ...word, bbox: {
                  x0: left + word.bbox.x0 / 2, x1: left + word.bbox.x1 / 2,
                  y0: top + word.bbox.y0 / 2, y1: top + word.bbox.y1 / 2,
                } }));
                const x0 = Math.min(...mapped.map(w => w.bbox.x0)), x1 = Math.max(...mapped.map(w => w.bbox.x1));
                // Preserve every original word outside the newly read caption.
                // In particular, never drop a nearby addition the crop missed.
                const replaced = line.indices.filter(i => {
                  const center = (words[i].bbox.x0 + words[i].bbox.x1) / 2;
                  return center >= x0 && center <= x1;
                });
                if (replaced.length) {
                  replaced.forEach(i => removed.add(i));
                  replacements.set(Math.min(...replaced), mapped);
                }
              } finally { detail.width = detail.height = 0; }
            }
          } finally { if (worker === current) await current.setParameters({ tessedit_pageseg_mode: "3" }); }
          words = words.flatMap((word, index) => replacements.get(index) || (removed.has(index) ? [] : [word]));
        }
        let retryReviews = [];
        const comparisonReference = sealedTextReference(reference.text, reference.evidence);
        if (comparisonReference.text.trim() && !contrastAssisted) {
          const reading = { words, codes: prepared.codes, corners: prepared.corners };
          const comparison = comparePageReading(reference.text, reading, canvas, reference.evidence);
          const lines = signedPhotoLines(comparisonReference.text, comparisonReference.evidence, prepared.corners, canvas, words);
          const candidates = planTextRetries(words, comparison, lines, canvas);
          if (candidates.length) {
            const replacements = [], alternateReviews = [];
            let source = null, pixels = 0;
            await current.setParameters({ tessedit_pageseg_mode: "7" });
            try {
              // Both engines see original pixels, including faint additions.
              // Never feed expected text or a signed-text-derived whitelist.
              if (reference.file) source = await openPhotoSource(reference.file);
              const alternate = await abortable(prepareSecondary(), controller.signal);
              controller.signal.throwIfAborted();
              const input = source?.image || canvas;
              const sx = (source?.width || canvas.width) / canvas.width;
              const sy = (source?.height || canvas.height) / canvas.height;
              // Model preparation is a separate cold-start cost; the existing
              // cooperative budget bounds all actual retry recognition work.
              const deadline = performance.now() + TEXT_RETRY_MS;
              for (const candidate of candidates) {
                if (performance.now() >= deadline || pixels >= TEXT_RETRY_PIXELS) break;
                const box = candidate.bbox, width = box.x1 - box.x0, height = box.y1 - box.y0;
                const before = candidate.indices.map(index => words[index]);
                const readings = [];
                // Fixed order and scale per model. One shared crop/time budget.
                for (const engine of [current, alternate].filter(Boolean)) {
                  if (performance.now() >= deadline) break;
                  controller.signal.throwIfAborted();
                  const border = engine === alternate ? 20 : 0;
                  const scale = engine === alternate ? 2 : Math.min(Math.max(1, sx, 64 / height), 3, Math.sqrt(500000 / (width * height)));
                  const detail = document.createElement("canvas");
                  const drawWidth = Math.max(1, Math.round(width * scale)), drawHeight = Math.max(1, Math.round(height * scale));
                  detail.width = drawWidth + border * 2; detail.height = drawHeight + border * 2;
                  const area = detail.width * detail.height;
                  if (pixels + area > TEXT_RETRY_PIXELS) { detail.width = detail.height = 0; continue; }
                  pixels += area;
                  try {
                    const context = detail.getContext("2d");
                    if (border) { context.fillStyle = "white"; context.fillRect(0, 0, detail.width, detail.height); }
                    context.drawImage(input, box.x0 * sx, box.y0 * sy, width * sx, height * sy,
                      border, border, drawWidth, drawHeight);
                    const reading = await recognize(detail, engine);
                    // Reject the entire alternative if any claimed glyph lies
                    // in synthetic padding or has invalid geometry. Do not drop
                    // individual words to manufacture a cleaner transcript.
                    if (reading.some(word => !word.bbox || !["x0", "y0", "x1", "y1"].every(key => Number.isFinite(word.bbox[key]))
                      || word.bbox.x1 <= word.bbox.x0 || word.bbox.y1 <= word.bbox.y0
                      || word.bbox.x0 < border || word.bbox.y0 < border
                      || word.bbox.x1 > border + drawWidth || word.bbox.y1 > border + drawHeight)) continue;
                    readings.push(reading.map(word => ({ ...word, bbox: {
                      x0: box.x0 + (word.bbox.x0 - border) * width / drawWidth,
                      x1: box.x0 + (word.bbox.x1 - border) * width / drawWidth,
                      y0: box.y0 + (word.bbox.y0 - border) * height / drawHeight,
                      y1: box.y0 + (word.bbox.y1 - border) * height / drawHeight,
                    } })));
                  } finally { detail.width = detail.height = 0; }
                }
                let selected = before;
                for (const reading of readings) if (preferTextRetry(before, reading) && preferTextRetry(selected, reading)) selected = reading;
                if (selected !== before) replacements.push({ candidate, words: selected });
                const transcript = selected.map(word => word.text).join(" ");
                for (const reading of readings) {
                  const observed = reading.map(word => word.text).join(" ");
                  // Cross-model confidence is only a heuristic. Preserve a
                  // credible losing alternative as an explicit review too.
                  if (observed !== transcript && reading.length && (preferTextRetry(before, reading)
                    || reading.every(word => Number.isFinite(word.confidence) && word.confidence >= OCR_REVIEW_THRESHOLD)))
                    alternateReviews.push({ original: transcript, observed, boxes: [box] });
                }
              }
            } finally {
              source?.release();
              if (readEpoch === generation && worker === current) await current.setParameters({ tessedit_pageseg_mode: "3" });
            }
            ({ words, retryReviews } = applyTextRetries(words, replacements));
            retryReviews.push(...alternateReviews);
          }
        }
        return { words, codes: prepared.codes, corners: prepared.corners, contrastAssisted, retryReviews };
      } catch (error) {
        if (readEpoch === generation) dispose();
        throw error;
      } finally {
        controller.abort();
        if (preprocessing === controller) preprocessing = null;
        if (prepared?.canvas) prepared.canvas.width = prepared.canvas.height = 0;
      }
    },
    dispose,
  };
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Reading cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function openPhotoSource(file) {
  if (!file || !/^image\/(jpeg|png|webp)$/.test(file.type)) {
    throw new Error("Choose a JPEG, PNG, or WebP page photo.");
  }
  if (file.size > 30 * 1024 * 1024) throw new Error("Choose a photo smaller than 30 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const pixels = image.naturalWidth * image.naturalHeight;
    if (!pixels || pixels > 60_000_000) throw new Error("Choose a photo with at most 60 megapixels.");
    return { image, width: image.naturalWidth, height: image.naturalHeight,
      release() { image.src = ""; URL.revokeObjectURL(url); } };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

export async function openPagePhoto(file) {
  const source = await openPhotoSource(file);
  try {
    const { image, width, height } = source;
    const scale = Math.min(1, Math.sqrt(6_000_000 / (width * height)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("This browser cannot open the page photo.");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally { source.release(); }
}

export function photoPreviewUrl(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (!blob) reject(new Error("This browser cannot display the page photo."));
    else resolve(URL.createObjectURL(blob));
  }, "image/png"));
}
