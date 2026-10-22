import { AnnotationMode, AnnotationType, getDocument, GlobalWorkerOptions, OPS, version } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

// Vite emits a same-origin worker for production/offline use. In Node, PDF.js
// uses its own fake-worker module so the same extractor can run in tests.
if (typeof window !== "undefined" && typeof Worker !== "undefined") {
  GlobalWorkerOptions.workerSrc = workerUrl;
}

const formError = "This PDF still contains interactive form fields after preparation. Export or print it to a text PDF and check every value before sealing.";

async function pdfAssetBase() {
  if (import.meta.env.SSR) {
    const { createRequire } = await import("node:module");
    const { dirname } = await import("node:path");
    return `${dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))}/`;
  }
  return `${import.meta.env.BASE_URL}pdfjs/${version}/`;
}

async function assertReadableFonts(page, pageNumber) {
  // PDF.js can replace a failed font with ErrorFont and return partial text
  // even with stopAtErrors. Its operator list still references that font;
  // commonObjs resolves it to an error string instead of a font object.
  // Keep this check covered by real malformed-font tests when upgrading PDF.js.
  const { fnArray, argsArray } = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
  const ids = new Set();
  fnArray.forEach((operation, index) => {
    if (operation === OPS.setFont) ids.add(argsArray[index][0]);
    if (operation === OPS.setGState) {
      for (const [name, value] of argsArray[index][0]) {
        if (name === "Font") ids.add(value[0]);
      }
    }
  });
  for (const id of ids) {
    const font = await new Promise((resolve) => page.commonObjs.get(id, resolve));
    if (!font || typeof font !== "object") {
      throw new Error(`Cannot reliably read all text on PDF page ${pageNumber}: a font or character map could not be loaded. Reconnect and retry, or export a PDF with embedded fonts.`);
    }
  }
}

export async function withPdfDocument(file, read) {
  const assetBase = await pdfAssetBase();
  const task = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
    wasmUrl: `${assetBase}wasm/`,
    useSystemFonts: true,
    isEvalSupported: false,
    stopAtErrors: true,
  });
  try {
    const pdf = await task.promise;
    if (!pdf.numPages) throw new Error("The PDF has no pages");
    return await read(pdf);
  } finally {
    await task.destroy();
  }
}

// Render the visible crop with annotations, without changing the original PDF.
// Rotation zero gives layout coordinates in the page's own coordinate system;
// the saved page retains its original rotation and crop.
export async function renderPdfPage(pdf, number, scale = 2) {
  const page = await pdf.getPage(number);
  const viewport = page.getViewport({ scale, rotation: 0 });
  if (viewport.width * viewport.height > 12_000_000) throw new Error("This page is too large for experimental watermark sealing. Choose a footer layout.");
  if (page.userUnit !== 1) throw new Error("Experimental watermarks do not support this PDF's custom page units. Choose a footer layout.");
  const canvas = pdf.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
  try {
    await page.render({ canvasContext: canvas.context, viewport, annotationMode: AnnotationMode.ENABLE }).promise;
    const image = canvas.context.getImageData(0, 0, canvas.canvas.width, canvas.canvas.height);
    const [x, y, right, top] = page.view;
    return { data: image.data, width: image.width, height: image.height, scale,
      bounds: { x, y, width: right - x, height: top - y } };
  } finally {
    pdf.canvasFactory.destroy(canvas);
    page.cleanup();
  }
}

export async function extractPdfPageTexts(file) {
  return withPdfDocument(file, async (pdf) => {
    const { info } = await pdf.getMetadata();
    if (info.IsAcroFormPresent || info.IsXFAPresent) throw new Error(formError);
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const annotations = await page.getAnnotations();
      if (annotations.some((annotation) => annotation.annotationType === AnnotationType.WIDGET)) throw new Error(formError);
      await assertReadableFonts(page, number);
      const { items } = await page.getTextContent();
      let text = "";
      for (const item of items) {
        if (typeof item.str !== "string") continue;
        text += item.str;
        if (item.hasEOL) text += "\n";
      }
      pages.push(text.trim());
      page.cleanup();
    }
    return pages;
  });
}
