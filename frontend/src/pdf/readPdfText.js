import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

// Vite emits a same-origin worker for production/offline use. In Node, PDF.js
// uses its own fake-worker module so the same extractor can run in tests.
if (typeof window !== "undefined" && typeof Worker !== "undefined") {
  GlobalWorkerOptions.workerSrc = workerUrl;
}

export async function extractPdfPageTexts(file) {
  const task = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useSystemFonts: true,
    isEvalSupported: false,
    stopAtErrors: true,
  });
  try {
    const pdf = await task.promise;
    if (!pdf.numPages) throw new Error("The PDF has no pages");
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
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
