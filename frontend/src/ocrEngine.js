// The browser uses only versioned, same-origin assets. Node uses the same
// locked English model for offline sealing and regression tests.
export const OCR_ASSET_PATH = "/ocr/v1";
export const DOCUMENT_OCR_PARAMETERS = { tessedit_pageseg_mode: "3", thresholding_method: "2", thresholding_kfactor: "0.2" };

export function openLocalOcrWorker(factory, logger, nodeModel = null) {
  return factory("eng", 1, {
    ...(nodeModel ? { langPath: nodeModel } : {
      workerPath: `${OCR_ASSET_PATH}/worker.min.js`, langPath: OCR_ASSET_PATH, corePath: OCR_ASSET_PATH, workerBlobURL: false,
    }),
    cacheMethod: "none", logger, errorHandler: () => {},
  });
}

// For a narrow word segmented sideways, the pinned engine can report the
// symbol extents in a rotated coordinate system. Keep them only when rotating
// back exactly reproduces the photographed word's vertical bounds.
function verticalGlyphs(bbox, symbols, pageHeight) {
  if (!pageHeight || !bbox || bbox.y1 - bbox.y0 < 2 * (bbox.x1 - bbox.x0) ||
      !symbols || symbols.length < 2 || symbols.length > 64) return undefined;
  const extents = symbols.map(symbol => symbol.bbox);
  if (!extents.every(b => b && b.y0 === pageHeight && b.y1 === pageHeight && b.x1 > b.x0) ||
      Math.abs(pageHeight - Math.max(...extents.map(b => b.x1)) - bbox.y0) > 1 ||
      Math.abs(pageHeight - Math.min(...extents.map(b => b.x0)) - bbox.y1) > 1) return undefined;
  return extents.map(b => ({ x0: bbox.x0, x1: bbox.x1, y0: pageHeight - b.x1, y1: pageHeight - b.x0 }));
}

export function recognizedWords(data, pass, pageHeight) {
  return (data.blocks || []).flatMap((block, b) => (block.paragraphs || []).flatMap((paragraph, p) =>
    (paragraph.lines || []).flatMap((line, l) => (line.words || []).map(({ text, confidence, bbox, symbols }) => {
      const glyphs = verticalGlyphs(bbox, symbols, pageHeight);
      return { text, confidence, bbox, lineId: `${pass}:${b}:${p}:${l}`, ...(glyphs ? { verticalGlyphs: glyphs } : {}) };
    }))));
}
