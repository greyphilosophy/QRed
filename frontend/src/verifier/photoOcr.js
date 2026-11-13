import { createWorker } from "tesseract.js";
import { DOCUMENT_OCR_PARAMETERS, openLocalOcrWorker, recognizedWords } from "../ocrEngine.js";
import { captionLineCandidates, comparePageReading, isPrintedCaption, preparePhotoReading } from "./photoReading.js";
import { signedPhotoLines } from "./photoTextLayout.js";
import { applyTextRetries, planTextRetries, TEXT_RETRY_MS, TEXT_RETRY_PIXELS } from "./photoOcrRetry.js";
import { needsPageReread, pageReadingCanvas, preferPageReread } from "./photoOcrFallback.js";
import { spacePhotoLine } from "./photoLineSpacing.js";
import { dateReadingCanvas } from "./photoDateField.js";

export function createPhotoOcrReader(workerFactory = createWorker, prepareImage = preparePhotoReading) {
  let worker = null, pending = null, generation = 0;
  let preprocessing = null;
  let progress = () => {};

  async function prepare(onProgress = () => {}) {
    progress = onProgress;
    if (worker) return worker;
    if (!pending) {
      const epoch = generation;
      pending = openLocalOcrWorker(workerFactory, event => { if (epoch === generation) progress(event); }).then(async next => {
        if (epoch !== generation) { await next.terminate(); throw new Error("Reading cancelled."); }
        worker = next;
        // A pale watermark can dominate a page-wide threshold and turn the
        // background into letters. Local adaptive thresholding reads the
        // original pixels, including faint additions, without a second pass.
        // A less aggressive factor retains light-gray additions that the
        // engine's default Sauvola factor can discard beside a watermark.
        await next.setParameters(DOCUMENT_OCR_PARAMETERS);
        return next;
      }).catch(error => {
        if (epoch === generation) { pending = null; worker?.terminate(); worker = null; }
        throw error;
      });
    }
    return pending;
  }

  return {
    prepare,
    async read(canvas, onProgress = () => {}, reference = {}) {
      let pass = 0;
      const current = await prepare(event => {
        // Only the first whole-page reading has a useful percentage. Recovery
        // and caption passes are additional work, not a restart of page progress.
        if (pass === 1) onProgress(event);
      });
      // The signed text is deliberately never supplied to the recognition engine.
      const recognize = async image => {
        controller.signal.throwIfAborted();
        pass++;
        const { data } = await current.recognize(image, {}, { text: true, blocks: true });
        controller.signal.throwIfAborted();
        onProgress({ status: "processing" });
        return recognizedWords(data, pass);
      };
      const controller = new AbortController();
      preprocessing = controller;
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
        // The filtered copy is a last resort for empty segmentation. A noisy
        // original can also get one independent, stronger-threshold reading;
        // preserve its first reading and label the second pass's limitations.
        let contrastAssisted = words.length === 0, originalReading;
        if (contrastAssisted) words = await recognize(prepared.canvas);
        else if (needsPageReread(words)) {
          const page = pageReadingCanvas(prepared.canvas, prepared.corners);
          if (page) try {
            await current.setParameters({ thresholding_kfactor: "0.34" });
            const reread = await recognize(page);
            if (preferPageReread(words, reread)) {
              originalReading = words; words = reread; contrastAssisted = true;
            }
          } finally {
            page.width = page.height = 0;
            if (worker === current) await current.setParameters({ thresholding_kfactor: "0.2" });
          }
        }
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
        if (reference.text?.trim() && (!contrastAssisted || originalReading)) {
          const reading = { words, codes: prepared.codes, corners: prepared.corners };
          const comparison = comparePageReading(reference.text, reading, canvas, reference.evidence, { pageNumber: reference.pageNumber });
          const lines = signedPhotoLines(reference.text, reference.evidence, prepared.corners, canvas, words);
          const candidates = planTextRetries(words, comparison, lines, canvas);
          if (candidates.length) {
            const replacements = [], deadline = performance.now() + TEXT_RETRY_MS;
            let source = null, pixels = 0;
            // A line crop needs its own threshold: retaining every watermark
            // edge can hide an entire numeric column. Changed first readings
            // remain in retryReviews, including any faint words this misses.
            await current.setParameters({ tessedit_pageseg_mode: "7", thresholding_kfactor: "0.34" });
            try {
              for (const candidate of candidates) {
                if (performance.now() >= deadline) break;
                controller.signal.throwIfAborted();
                const box = candidate.bbox, width = box.x1 - box.x0, height = box.y1 - box.y0;
                if (candidate.dateField) {
                  const detail = dateReadingCanvas(canvas, box, Math.min(500000, TEXT_RETRY_PIXELS - pixels));
                  if (!detail) continue;
                  pixels += detail.width * detail.height;
                  try {
                    const read = await recognize(detail);
                    // Only a single complete date may replace the isolated
                    // word. Its position is the original word's page location.
                    if (read.length === 1 && read[0].bbox) {
                      const original = words[candidate.indices[0]];
                      replacements.push({ candidate, words: [{ ...read[0], bbox: original.bbox, lineId: original.lineId }] });
                    }
                  } finally { detail.width = detail.height = 0; }
                  continue;
                }
                // Only line crops need the retained file at native resolution.
                if (reference.file && !source) {
                  source = await openPhotoSource(reference.file);
                  controller.signal.throwIfAborted();
                  if (performance.now() >= deadline) break;
                }
                const input = source?.image || canvas;
                const sx = (source?.width || canvas.width) / canvas.width;
                const sy = (source?.height || canvas.height) / canvas.height;
                const scale = Math.min(Math.max(1, sx, 64 / height), 3, Math.sqrt(500000 / (width * height)));
                const detail = document.createElement("canvas");
                detail.width = Math.max(1, Math.round(width * scale));
                detail.height = Math.max(1, Math.round(height * scale));
                pixels += detail.width * detail.height;
                if (pixels > TEXT_RETRY_PIXELS) { detail.width = detail.height = 0; break; }
                try {
                  const context = detail.getContext("2d", { willReadFrequently: true });
                  context.drawImage(input, box.x0 * sx, box.y0 * sy, width * sx, height * sy,
                    0, 0, detail.width, detail.height);
                  const originalWidth = detail.width, originalHeight = detail.height;
                  const spaced = originalReading && candidate.signedLine
                    ? spacePhotoLine(context.getImageData(0, 0, originalWidth, originalHeight)) : null;
                  if (spaced) {
                    pixels += Math.max(0, spaced.width * spaced.height - originalWidth * originalHeight);
                    if (pixels > TEXT_RETRY_PIXELS) break;
                    detail.width = spaced.width; detail.height = spaced.height;
                    context.putImageData(new ImageData(spaced.data, spaced.width, spaced.height), 0, 0);
                  }
                  const read = await recognize(detail);
                  const sourceX = x => spaced ? spaced.sourceX[Math.max(0, Math.min(spaced.width, Math.round(x)))] : x;
                  const sourceY = y => spaced ? Math.max(0, Math.min(originalHeight, y - spaced.pad)) : y;
                  const mapped = read.filter(word => word.bbox).map(word => ({ ...word, bbox: {
                    x0: box.x0 + sourceX(word.bbox.x0) * width / originalWidth, x1: box.x0 + sourceX(word.bbox.x1) * width / originalWidth,
                    y0: box.y0 + sourceY(word.bbox.y0) * height / originalHeight, y1: box.y0 + sourceY(word.bbox.y1) * height / originalHeight,
                  } }));
                  replacements.push({ candidate, words: mapped });
                } finally { detail.width = detail.height = 0; }
              }
            } finally {
              source?.release();
              if (worker === current) await current.setParameters({ tessedit_pageseg_mode: "3", thresholding_kfactor: "0.2" });
            }
            ({ words, retryReviews } = applyTextRetries(words, replacements));
          }
        }
        return { words, codes: prepared.codes, corners: prepared.corners, contrastAssisted, retryReviews, originalReading };
      } finally {
        controller.abort();
        if (preprocessing === controller) preprocessing = null;
        if (prepared?.canvas) prepared.canvas.width = prepared.canvas.height = 0;
      }
    },
    dispose() {
      generation += 1;
      progress = () => {};
      preprocessing?.abort(); preprocessing = null;
      worker?.terminate();
      worker = null;
      pending = null;
    },
  };
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
