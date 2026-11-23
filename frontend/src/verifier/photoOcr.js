import { createWorker } from "tesseract.js";
import { DOCUMENT_OCR_PARAMETERS, openLocalOcrWorker, recognizedWords } from "../ocrEngine.js";
import { captionLineCandidates, comparePageReading, isPrintedCaption, preparePhotoReading } from "./photoReading.js";
import { locateNavigationCaption } from "./photoNavigationCaption.js";
import { signedPhotoLines } from "./photoTextLayout.js";
import { applyTextRetries, planTextRetries, MAX_TEXT_RETRIES, TEXT_RETRY_MS, TEXT_RETRY_PIXELS } from "./photoOcrRetry.js";
import { needsPageReread, pageReadingCanvas, preferPageReread } from "./photoOcrFallback.js";
import { spacePhotoLine } from "./photoLineSpacing.js";
import { planDateTableRetry, contrastCropCanvas, prepareDateColumn, applyDateColumn } from "./photoDateTable.js";
import { selectProseReading } from "./photoProseRetry.js";
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
        const navigation = await locateNavigationCaption(canvas, words, prepared.codes,
          { pageNumber: reference.pageNumber, prepareImage, signal: controller.signal });
        const candidates = captionLineCandidates(words, prepared.codes).filter(line =>
          !navigation || !line.indices.some(i => navigation.line.indices.includes(i)));
        if (navigation) candidates.unshift(navigation.line);
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
                const context = detail.getContext("2d");
                // Both end words have descenders. Their lower edges give the
                // caption baseline, even when the whole page is slightly tilted.
                if (line.tilt) {
                  context.fillStyle = "white"; context.fillRect(0, 0, detail.width, detail.height);
                  context.translate(detail.width / 2, detail.height / 2); context.rotate(-line.tilt);
                  context.translate(-detail.width / 2, -detail.height / 2);
                }
                context.drawImage(canvas, left, top, width, height, 0, 0, detail.width, detail.height);
                const caption = await recognize(detail);
                if (!isPrintedCaption(caption)) continue;
                const inverse = line.tilt && context.getTransform().inverse();
                const mapped = caption.map(word => {
                  const { x0, x1, y0, y1 } = word.bbox;
                  const points = [{ x: x0, y: y0 }, { x: x0, y: y1 }, { x: x1, y: y0 }, { x: x1, y: y1 }]
                    .map(p => inverse ? inverse.transformPoint(p) : p);
                  return { ...word, bbox: {
                    x0: left + Math.min(...points.map(p => p.x)) / 2, x1: left + Math.max(...points.map(p => p.x)) / 2,
                    y0: top + Math.min(...points.map(p => p.y)) / 2, y1: top + Math.max(...points.map(p => p.y)) / 2,
                  } };
                });
                const x0 = Math.min(...mapped.map(w => w.bbox.x0)), x1 = Math.max(...mapped.map(w => w.bbox.x1));
                // Preserve every original word outside the newly read caption.
                // In particular, never drop a nearby addition the crop missed.
                const replaced = line.indices.filter(i => {
                  const center = (words[i].bbox.x0 + words[i].bbox.x1) / 2;
                  return center >= x0 && center <= x1;
                });
                if (line === navigation?.line) {
                  // All three printed words must occupy their original places on an
                  // independent reading. Other lettering inside or beside this crop
                  // never belongs to the confirmed caption.
                  if (caption.map(w => w.text).join(" ") !== "Verify at qred.org" ||
                      replaced.length !== 3 || mapped.some((w, j) => {
                        const b = words[line.indices[j]].bbox, center = (w.bbox.x0 + w.bbox.x1) / 2;
                        return center < b.x0 || center > b.x1 || w.bbox.y1 <= b.y0 || w.bbox.y0 >= b.y1;
                      })) continue;
                  mapped.forEach((word, j) => {
                    word.confirmedNavigationCaption = true;
                    // Keep the tighter glyph bounds from the original photograph.
                    word.bbox = words[line.indices[j]].bbox;
                  });
                  if (!prepared.codes.includes(navigation.code)) prepared.codes = [...prepared.codes, navigation.code];
                }
                if (replaced.length) {
                  replaced.forEach(i => removed.add(i));
                  replacements.set(Math.min(...replaced), mapped);
                }
              } finally { detail.width = detail.height = 0; }
            }
          } finally { if (worker === current) await current.setParameters({ tessedit_pageseg_mode: "3" }); }
          words = words.flatMap((word, index) => replacements.get(index) || (removed.has(index) ? [] : [word]));
        }
        let retryReviews = [], resolvedCrops = [];
        if (reference.text?.trim() && (!contrastAssisted || originalReading)) {
          const reading = { words, codes: prepared.codes, corners: prepared.corners };
          const compareWords = nextWords => comparePageReading(reference.text, { ...reading, words: nextWords },
            canvas, reference.evidence, { pageNumber: reference.pageNumber });
          const comparison = compareWords(words);
          const lines = signedPhotoLines(reference.text, reference.evidence, prepared.corners, canvas, words);
          let candidates = planTextRetries(words, comparison, lines, canvas);
          const table = planDateTableRetry(words, lines, canvas);
          if (table || candidates.length) {
            const replacements = [], deadline = performance.now() + TEXT_RETRY_MS;
            let source = null, pixels = 0;
            // A local threshold can recover a numeric column beside a watermark.
            // Keep unresolved disagreements, including faint words it misses.
            await current.setParameters({ tessedit_pageseg_mode: "7", thresholding_kfactor: "0.34" });
            try {
              if (table) {
                if (reference.file) source = await openPhotoSource(reference.file);
                controller.signal.throwIfAborted();
                const crop = performance.now() < deadline && prepareDateColumn(source?.image || canvas, table,
                  (source?.width || canvas.width) / canvas.width, (source?.height || canvas.height) / canvas.height,
                  Math.min(500000, TEXT_RETRY_PIXELS));
                if (crop) try {
                  pixels += crop.canvas.width * crop.canvas.height;
                  await current.setParameters({ tessedit_pageseg_mode: "6" });
                  const read = await recognize(crop.canvas);
                  const result = applyDateColumn(words, table, read.filter(w => w.bbox).map(w => ({ ...w, bbox: crop.project(w.bbox) })));
                  words = result.words; retryReviews.push(...result.retryReviews);
                  candidates = planTextRetries(words, compareWords(words), lines, canvas).slice(0, MAX_TEXT_RETRIES - 1);
                } finally {
                  crop.canvas.width = crop.canvas.height = 0;
                  if (worker === current) await current.setParameters({ tessedit_pageseg_mode: "7" });
                }
              }
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
                if (candidate.prose) {
                  const crop = contrastCropCanvas(input, box, sx, sy, Math.min(500000, TEXT_RETRY_PIXELS - pixels), 1);
                  if (crop) try {
                    pixels += crop.canvas.width * crop.canvas.height;
                    await current.setParameters({ tessedit_pageseg_mode: "6" });
                    const read = await recognize(crop.canvas);
                    const evidence = selectProseReading(words, candidate, read.filter(w => w.bbox).map(w => ({ ...w, bbox: crop.project(w.bbox) })));
                    if (evidence) replacements.push({ candidate, words: evidence });
                  } finally {
                    crop.canvas.width = crop.canvas.height = 0;
                    if (worker === current) await current.setParameters({ tessedit_pageseg_mode: "7" });
                  }
                  continue;
                }
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
                  const spaced = candidate.separatedValue || (originalReading && candidate.signedLine)
                    ? spacePhotoLine(context.getImageData(0, 0, originalWidth, originalHeight), candidate.separatedValue) : null;
                  if (candidate.separatedValue && !spaced) continue;
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
                  if (mapped.length && spaced?.separator) {
                    const mark = spaced.separator;
                    mapped[0].precedingSeparatorBox = {
                      x0: box.x0 + mark.x0 * width / originalWidth, x1: box.x0 + mark.x1 * width / originalWidth,
                      y0: box.y0 + mark.y0 * height / originalHeight, y1: box.y0 + mark.y1 * height / originalHeight };
                  }
                  replacements.push({ candidate, words: mapped });
                } finally { detail.width = detail.height = 0; }
              }
            } finally {
              source?.release();
              if (worker === current) await current.setParameters({ tessedit_pageseg_mode: "3", thresholding_kfactor: "0.2" });
            }
            const result = applyTextRetries(words, replacements, compareWords);
            words = result.words; resolvedCrops = result.resolvedCrops; retryReviews.push(...result.retryReviews);
          }
        }
        return { words, codes: prepared.codes, corners: prepared.corners, contrastAssisted, retryReviews, originalReading,
          ...(originalReading && resolvedCrops.length ? { resolvedCrops } : {}) };
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
