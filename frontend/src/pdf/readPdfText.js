import { AnnotationMode, AnnotationType, getDocument, GlobalWorkerOptions, OPS, version } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

// Vite emits a same-origin worker for production/offline use. In Node, PDF.js
// uses its own fake-worker module so the same extractor can run in tests.
if (typeof window !== "undefined" && typeof Worker !== "undefined") {
  GlobalWorkerOptions.workerSrc = workerUrl;
}

const formError = "This PDF contains interactive form fields. Flatten or print it to a text PDF and check that every value is visible before sealing.";

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

export async function extractPdfPageTexts(file) {
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
  } finally {
    await task.destroy();
  }
}
