import { decodePhoto, qrFrameAction } from "./decodePhoto.js";
import { createQrFrameScanner } from "./scanQrImage.js";
import { createPageCaptureGate } from "./pageCaptureQuality.js";
import { preparePhotoReadingPixels } from "../verifier/photoReadingPixels.js";
import { decodeSeal } from "../qredVerifier.js";

// A camera session submits one frame at a time. Quality-approved captures
// finish all recovery on that photo; ordinary live scanning stays bounded.
let scanQrFrame;
const captureGate = createPageCaptureGate();
self.onmessage = ({ data: { image, returnPayload, live = false, requirePageQuality = false, frameTime, prepareReading = false } }) => {
  try {
    if (prepareReading) {
      const action = preparePhotoReadingPixels(image);
      self.postMessage({ action }, [action.image.data.buffer]);
      return;
    }
    scanQrFrame ??= createQrFrameScanner({ preferWatermark: requirePageQuality });
    const quality = requirePageQuality ? captureGate.update(image, frameTime) : null;
    // The submitted frame is already frozen in the worker and the caller's
    // canvas. Acknowledge it before decoding so moving the phone cannot spoil it.
    if (quality?.ready) self.postMessage({ captured: true, quality });
    let action = quality && !quality.ready ? { status: "continue" } : live
      ? qrFrameAction(image, scanQrFrame(image.data, image.width, image.height), { returnPayload })
      : decodePhoto(image, { returnPayload });
    if (quality?.ready && (action.status === "continue"
      || (action.status === "found" && decodeSeal(action.text)?.total_chunks > 1))) {
      // Once capture is acknowledged, every recovery attempt must use this
      // photograph, including the remaining pieces of a multipart page.
      action = decodePhoto(image, { returnPayload });
    }
    if (quality?.ready && action.status === "continue") action = {
      status: "feedback", message: "The page seal could not be read. Frame the page again, or use Capture now.",
    };
    self.postMessage(quality ? { action, quality } : { action });
  }
  catch (error) { self.postMessage({ error: error.message || "The photo could not be scanned." }); }
};
