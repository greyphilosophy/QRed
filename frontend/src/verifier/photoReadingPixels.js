import { scanQrImage } from "../qr/scanQrImage.js";
import { maskQrCode } from "../qr/maskQrCode.js";
import { isQRedEntryLink, qredPayloadFromScanResult } from "../qr/qrPayload.js";
import { decodeSeal } from "../qredVerifier.js";
import { locatePaper } from "../qr/pageAlignedScan.js";

// Runs in the photo worker on a transferred working copy, never the retained
// photograph. The contrast copy can lose pale writing; its reading is always
// qualified, and recognition of the original is preserved separately.
export function preparePhotoReadingPixels({ data, width, height }) {
  // Measure geometry before the contrast copy removes pale ink and colour.
  // This is a bounded edge search, not another seal-recovery attempt.
  const corners = locatePaper({ data, width, height });
  for (let i = 0; i < data.length; i += 4) {
    if (Math.min(data[i], data[i + 1], data[i + 2]) > 150)
      data[i] = data[i + 1] = data[i + 2] = 255;
  }
  const codes = [];
  let search = data;
  try {
    for (let count = 0; count < 8; count++) {
      // Classification of small printed markings needs one native-scale pass,
      // not the multi-scale payload-recovery search on every OCR page.
      const code = scanQrImage(search, width, height,
        { tryRescaling: false, tryWatermark: false, maxAttempts: 1 });
      if (!code) break;
      const text = qredPayloadFromScanResult(code) || code.data;
      const points = ["topLeftCorner", "topRightCorner", "bottomLeftCorner", "bottomRightCorner"].map(key => code.location?.[key]);
      if (points.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) break;
      const box = { x0: Math.min(...points.map(p => p.x)), y0: Math.min(...points.map(p => p.y)),
        x1: Math.max(...points.map(p => p.x)), y1: Math.max(...points.map(p => p.y)) };
      if ((isQRedEntryLink(text) || decodeSeal(text)) &&
          (box.x1 - box.x0) * (box.y1 - box.y0) < width * height * .2) codes.push(box);
      // Mask only the search copy. OCR must still see ink underneath or beside
      // a copied stamp, including when somebody is using it to cover words.
      if (search === data) search = new Uint8ClampedArray(data);
      if (!maskQrCode(search, width, height, code)) break;
    }
    return { image: { data, width, height }, codes, corners };
  } finally { if (search !== data) search.fill(0); }
}
