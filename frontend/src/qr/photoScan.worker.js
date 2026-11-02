import { decodePhoto, qrFrameAction } from "./decodePhoto.js";
import { createQrFrameScanner } from "./scanQrImage.js";
import { createPageCaptureGate } from "./pageCaptureQuality.js";
import { preparePhotoReadingPixels } from "../verifier/photoReadingPixels.js";

// A camera session keeps its retry position, but submits only one fresh frame
// at a time. Live requests never enter the exhaustive still-photo decoder.
let scanQrFrame;
const captureGate = createPageCaptureGate();
let readingSince = null;
self.onmessage = ({ data: { image, returnPayload, live = false, requirePageQuality = false, frameTime, prepareReading = false } }) => {
  try {
    if (prepareReading) {
      const action = preparePhotoReadingPixels(image);
      self.postMessage({ action }, [action.image.data.buffer]);
      return;
    }
    scanQrFrame ??= createQrFrameScanner({ preferWatermark: requirePageQuality });
    const quality = requirePageQuality ? captureGate.update(image, frameTime) : null;
    const action = quality && !quality.ready ? { status: "continue" } : live
      ? qrFrameAction(image, scanQrFrame(image.data, image.width, image.height), { returnPayload })
      : decodePhoto(image, { returnPayload });
    if (quality) {
      if (!quality.ready || action.status === "found" || action.status === "found-multiple") readingSince = null;
      else {
        readingSince ??= frameTime;
        if (frameTime - readingSince > 3000) quality.message = "Still looking for the page seal. Try Capture now for a longer read.";
      }
    }
    self.postMessage(quality ? { action, quality } : { action });
  }
  catch (error) { self.postMessage({ error: error.message || "The photo could not be scanned." }); }
};
