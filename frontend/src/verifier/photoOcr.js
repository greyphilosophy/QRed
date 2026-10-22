import { createWorker } from "tesseract.js";

// These versioned resources are copied from locked dependencies at build time.
// Never use Tesseract's default CDN paths: all resources belong to this origin.
export const OCR_ASSET_PATH = "/ocr/v1";

export function createPhotoOcrReader(workerFactory = createWorker) {
  let worker = null, pending = null, generation = 0;
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
        await next.setParameters({ tessedit_pageseg_mode: "3" });
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
    async read(canvas, onProgress) {
      const current = await prepare(onProgress);
      // The signed text is deliberately never supplied to the recognition engine.
      const { data } = await current.recognize(canvas, {}, { text: true, blocks: true });
      return (data.blocks || []).flatMap(block => (block.paragraphs || [])
        .flatMap(paragraph => (paragraph.lines || []).flatMap(line => line.words || [])))
        .map(({ text, confidence, bbox }) => ({ text, confidence, bbox }));
    },
    dispose() {
      generation += 1;
      progress = () => {};
      worker?.terminate();
      worker = null;
      pending = null;
    },
  };
}

export async function openPagePhoto(file) {
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
    const scale = Math.min(1, Math.sqrt(6_000_000 / pixels));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot open the page photo.");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally { URL.revokeObjectURL(url); }
}

export function photoPreviewUrl(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (!blob) reject(new Error("This browser cannot display the page photo."));
    else resolve(URL.createObjectURL(blob));
  }, "image/png"));
}
