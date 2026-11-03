import { decodePhoto, qrFrameAction } from "./decodePhoto.js";
import { createQrFrameScanner } from "./scanQrImage.js";
import { createPageCaptureGate } from "./pageCaptureQuality.js";
import { preparePhotoReadingPixels } from "../verifier/photoReadingPixels.js";

// A camera session submits one frame at a time. Quality-approved captures
// finish all recovery on that photo; ordinary live scanning stays bounded.
let scanQrFrame;
const captureGate = createPageCaptureGate();
self.onmessage = ({ data: { image, returnPayload, live = false, requirePageQuality = false, captureOnly = false, frameTime, prepareReading = false } }) => {
  try {
    if (prepareReading) {
      const action = preparePhotoReadingPixels(image);
      self.postMessage({ action }, [action.image.data.buffer]);
      return;
    }
    scanQrFrame ??= createQrFrameScanner({ preferWatermark: requirePageQuality });
    const quality = requirePageQuality ? captureGate.update(image, frameTime) : null;
    // Hand capture to the camera without decoding its lower-detail preview.
    // Keep this worker's gate so unchanged paper cannot trigger another shot.
    if (quality?.ready && captureOnly) {
      self.postMessage({ captured: true, captureOnly: true, quality });
      return;
    }
    // The submitted frame is already frozen in the worker and the caller's
    // canvas. Acknowledge it before decoding so moving the phone cannot spoil it.
    if (quality?.ready) self.postMessage({ captured: true, quality });
    // Captured pages enter the bounded photo pipeline once. Repeating a live
    // preview first adds latency and can spend the whole attempt on a miss.
    let action = quality && !quality.ready ? { status: "continue" } : quality?.ready || !live
      ? decodePhoto(image, { returnPayload })
      : qrFrameAction(image, scanQrFrame(image.data, image.width, image.height), { returnPayload });
    if (quality?.ready && action.status === "continue") action = {
      status: "feedback", message: "The page seal could not be read. Frame the page again, or use Capture now.",
    };
    self.postMessage(quality ? { action, quality } : { action });
  }
  catch (error) { self.postMessage({ error: error.message || "The photo could not be scanned." }); }
};
