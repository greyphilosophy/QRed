import { decodePhoto, qrFrameAction } from "./decodePhoto.js";
import { createQrFrameScanner } from "./scanQrImage.js";

// A camera session keeps its retry position, but submits only one fresh frame
// at a time. Live requests never enter the exhaustive still-photo decoder.
const scanQrFrame = createQrFrameScanner();
self.onmessage = ({ data: { image, returnPayload, live = false } }) => {
  try {
    const action = live
      ? qrFrameAction(image, scanQrFrame(image.data, image.width, image.height), { returnPayload })
      : decodePhoto(image, { returnPayload });
    self.postMessage({ action });
  }
  catch (error) { self.postMessage({ error: error.message || "The photo could not be scanned." }); }
};
