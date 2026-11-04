import { AnnotationMode, getDocument, GlobalWorkerOptions, OPS, version } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { MAX_EXACT_PAGES, MAX_EXACT_PIXELS } from "./evidence.js";

// This identifies an explicitly bounded rendering PROCEDURE, not a claim that
// native Canvas is bit-identical across browsers/OSes. Any unequal bytes fail.
// SSR results deliberately cannot be presented as browser-generated evidence.
export const EXACT_PROFILE = `qred-exact-${import.meta.env.SSR ? "node-test" : "browser-canvas"}-v1/pdfjs-6.1.200/paths/rgba8-srgb-white/scale2`;
export const MAX_EXACT_PDF_BYTES = 32 * 1024 * 1024;
if (typeof window !== "undefined" && typeof Worker !== "undefined") GlobalWorkerOptions.workerSrc = workerUrl;

async function assetBase() {
  if (import.meta.env.SSR) {
    const { createRequire } = await import("node:module"), { dirname } = await import("node:path");
    return `${dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))}/`;
  }
  return `${import.meta.env.BASE_URL}pdfjs/${version}/`;
}
export async function withExactDocument(file, consume, { signal } = {}) {
  signal?.throwIfAborted();
  if (version !== "6.1.200") throw new Error("Unsupported exact-render PDF.js version");
  if (!file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_EXACT_PDF_BYTES)
    throw new Error("Exact rendering requires a PDF no larger than 32 MiB");
  const base = await assetBase(), data = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();
  if (data.length !== file.size || data.length > MAX_EXACT_PDF_BYTES) throw new Error("PDF size changed while reading");
  const task = getDocument({ data, cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`, useSystemFonts: false, disableFontFace: true, isEvalSupported: false, stopAtErrors: true,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false, enableHWA: false, enableXfa: false, useWasm: true });
  const cancel = () => { task.destroy().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const pdf = await task.promise; signal?.throwIfAborted();
    if (!pdf.numPages || pdf.numPages > MAX_EXACT_PAGES) throw new Error("Exact rendering supports 1 to 100 pages");
    const { info } = await pdf.getMetadata(); signal?.throwIfAborted();
    if (info.IsAcroFormPresent || info.IsXFAPresent) throw new Error("Exact rendering does not support interactive forms");
    return await consume(pdf);
  } finally { signal?.removeEventListener("abort", cancel); await task.destroy(); }
}
export async function renderExactPage(pdf, number, { signal } = {}) {
  signal?.throwIfAborted();
  const page = await pdf.getPage(number); signal?.throwIfAborted();
  const [left, bottom, right, top] = page.view, width = right * 2, height = top * 2;
  if (page.rotate !== 0 || page.userUnit !== 1 || left !== 0 || bottom !== 0 ||
      !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_EXACT_PIXELS)
    throw new Error("Exact rendering requires an unrotated origin-zero page with standard units and at most 3 million pixels at 144 dpi");
  if ((await page.getAnnotations({ intent: "display" })).length) throw new Error("Exact rendering does not support annotations");
  signal?.throwIfAborted();
  // stopAtErrors alone does not reject ErrorFont or all font substitutions.
  // Font paths must be available; never let missing fonts fall back to OS text.
  const { fnArray, argsArray } = await page.getOperatorList({ annotationMode: AnnotationMode.ENABLE });
  const fontIds = new Set();
  fnArray.forEach((operation, index) => {
    if (operation === OPS.setFont) fontIds.add(argsArray[index][0]);
    if (operation === OPS.setGState) for (const [name, value] of argsArray[index][0]) if (name === "Font") fontIds.add(value[0]);
  });
  for (const id of fontIds) {
    const font = await new Promise(resolve => page.commonObjs.get(id, resolve)); signal?.throwIfAborted();
    if (!font || typeof font !== "object" || font.missingFile || font.isInvalidPDFjsFont)
      throw new Error("Exact rendering cannot load all required font outlines");
  }
  signal?.throwIfAborted();
  const canvas = pdf.canvasFactory.create(width, height);
  try {
    const operation = page.render({ canvasContext: canvas.context, viewport: page.getViewport({ scale: 2, rotation: 0 }),
      intent: "display", annotationMode: AnnotationMode.ENABLE, background: "rgb(255,255,255)" });
    const cancel = () => operation.cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    try { await operation.promise; signal?.throwIfAborted(); }
    finally { signal?.removeEventListener("abort", cancel); }
    const image = canvas.context.getImageData(0, 0, width, height);
    return { width, height, data: image.data };
  } finally { pdf.canvasFactory.destroy(canvas); page.cleanup(); }
}
