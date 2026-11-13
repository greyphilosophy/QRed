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

export function recognizedWords(data, pass) {
  return (data.blocks || []).flatMap((block, b) => (block.paragraphs || []).flatMap((paragraph, p) =>
    (paragraph.lines || []).flatMap((line, l) => (line.words || []).map(({ text, confidence, bbox }) =>
      ({ text, confidence, bbox, lineId: `${pass}:${b}:${p}:${l}` })))));
}
