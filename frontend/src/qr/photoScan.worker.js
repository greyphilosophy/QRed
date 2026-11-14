import { decodePhoto, qrFrameAction } from "./decodePhoto.js";
import { createQrFrameScanner } from "./scanQrImage.js";
import { createPageCaptureGate } from "./pageCaptureQuality.js";
import { preparePhotoReadingPixels } from "../verifier/photoReadingPixels.js";
import { scanStageDiagnostic } from "./photoScanDiagnostics.js";
import { stackRegisteredBurst } from "./registeredBurst.js";
import { createRectifiedSealScanner, prepareCurvedPageScan } from "./rectifiedSealScan.js";
import { decodeSeal } from "../qredVerifier.js";
import { PHOTO_SCAN_BUDGET_MS } from "./photoScanBudget.js";

// A stack can contribute a complete page seal. The full decoder and the OCR
// canvas still have the first original if alignment or seal recovery misses.
async function scanBurst(image, blobs) {
  if (!blobs?.length || typeof OffscreenCanvas !== "function" || typeof createImageBitmap !== "function") return null;
  const start = performance.now(), frames = [];
  self.postMessage({ scanStage: { stage: "camera-burst", elapsedMs: 0 } });
  const canvas = new OffscreenCanvas(image.width, image.height);
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    for (const blob of blobs.slice(0, 2)) {
      let bitmap;
      try {
        bitmap = await createImageBitmap(blob);
        if (bitmap.width * bitmap.height > 80_000_000 || Math.abs(bitmap.width / bitmap.height - image.width / image.height) > .002) continue;
        ctx.drawImage(bitmap, 0, 0, image.width, image.height);
        frames.push(ctx.getImageData(0, 0, image.width, image.height));
      } catch { /* Use the remaining originals. */ }
      finally { bitmap?.close(); }
    }
  } finally { canvas.width = canvas.height = 0; }
  const stacked = stackRegisteredBurst(image, frames);
  frames.length = 0;
  if (stacked === image) return null;
  const shouldContinue = () => performance.now() < start + 6500;
  let measured;
  const scan = createRectifiedSealScanner(stacked, { onMapping: map => { measured = map; } });
  const flat = scan({ shouldContinue, searchRadius: 12 });
  const complete = read => {
    const seal = read && decodeSeal(read.seal);
    return seal?.total_chunks === 1 && !seal.seal_sheet ? { status: "found", text: read.seal } : null;
  };
  const result = complete(flat);
  if (result || !shouldContinue()) return result;
  const curved = prepareCurvedPageScan(stacked, measured, shouldContinue);
  return complete(curved?.scan({ shouldContinue, searchRadius: 12 }));
}

// A camera session submits one frame at a time. Quality-approved captures
// finish all recovery on that photo; ordinary live scanning stays bounded.
let scanQrFrame;
const captureGate = createPageCaptureGate();
self.onmessage = async ({ data: { image, returnPayload, burst, live = false, requirePageQuality = false, captureOnly = false, frameTime, prepareReading = false } }) => {
  try {
    const started = performance.now();
    let burstAttempted = false;
    if (prepareReading) {
      const action = preparePhotoReadingPixels(image);
      self.postMessage({ action }, [action.image.data.buffer]);
      return;
    }
    if (!live && returnPayload && burst?.length) {
      burstAttempted = true;
      // Optional processing must not block the usual original-photo scan.
      let found;
      try { found = await scanBurst(image, burst); } catch { /* Fall back to the original. */ }
      if (found) { self.postMessage({ action: found }); return; }
    }
    scanQrFrame ??= createQrFrameScanner({ preferWatermark: requirePageQuality });
    const quality = requirePageQuality ? captureGate.update(image, frameTime, { captureOnly }) : null;
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
      ? decodePhoto(image, { returnPayload,
        ...(burstAttempted ? { maxDurationMs: Math.max(0, PHOTO_SCAN_BUDGET_MS - (performance.now() - started)) } : {}),
        onProgress: action => self.postMessage({ progress: action }),
        onStage: value => {
          const scanStage = scanStageDiagnostic(value);
          if (scanStage) self.postMessage({ scanStage });
        } })
      : qrFrameAction(image, scanQrFrame(image.data, image.width, image.height), { returnPayload });
    if (quality?.ready && action.status === "continue") action = {
      status: "feedback", message: "The page seal could not be read. Frame the page again, or use Capture now.",
    };
    self.postMessage(quality ? { action, quality } : { action });
  }
  catch (error) { self.postMessage({ error: error.message || "The photo could not be scanned." }); }
};
