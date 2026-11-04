import { scanQrImage, scanWatermarkPreview } from "./scanQrImage.js";
import { scanPageAlignedImage } from "./pageAlignedScan.js";
import { scanFooterSeals } from "./footerSealScan.js";
import { scanRectifiedSeal } from "./rectifiedSealScan.js";
import { isQRedEntryLink, qredPayloadFromScanResult } from "./qrPayload.js";
import { validatePhotoImage } from "./photoScanImage.js";
import { decodeSeal, qredTextFromPhotoScanResult, qredPayloadFromPhotoScanResult,
  qredTextFromScanResult } from "../qredVerifier.js";

export function qrScanAction(data, width, height, code, { returnPayload = false } = {}) {
  if (!code) return { status: "continue" };
  const text = returnPayload
    ? qredPayloadFromPhotoScanResult(data, width, height, code)
    : qredTextFromPhotoScanResult(data, width, height, code);
  return text && !isQRedEntryLink(text) ? { status: "found", text } : { status: "continue" };
}

export function qrFrameAction(image, code, options = {}) {
  const { data, width, height } = image;
  if (code?.codes) {
    const texts = code.codes.map(result => qrScanAction(data, width, height, result, options))
      .filter(action => action.status === "found").map(action => action.text);
    return texts.length ? { status: "found-multiple", texts } : { status: "continue" };
  }
  return qrScanAction(data, width, height, code, options);
}

// The same decoder serves a chosen photo and a manually captured camera frame.
// Kept synchronous for existing callers. The browser worker wraps this with
// bounded asynchronous QRE discovery in decodePhotoWithErasure.js.
export function decodePhoto(image, { returnPayload = false, maxDurationMs = 8000 } = {}) {
  validatePhotoImage(image);
  const { data, width, height } = image;
  // Cooperatively stop between bounded attempts. A miss must return retake
  // guidance instead of spending a minute exhausting layout guesses.
  const started = performance.now(), deadline = started + maxDurationMs;
  const shouldContinue = () => performance.now() < deadline;
  const partials = new Set();
  if (returnPayload) {
    // Try the measured whole-page grid before general-purpose QR location.
    // Reserve half the cooperative budget for other layouts if this misses.
    const fastDeadline = started + maxDurationMs / 2;
    const fast = scanRectifiedSeal(image, {
      searchRadius: 12, shouldContinue: () => performance.now() < fastDeadline,
    });
    if (decodeSeal(fast?.seal)?.total_chunks === 1) return { status: "found", text: fast.seal };
    if (decodeSeal(fast?.seal)) partials.add(fast.seal);
    const preview = shouldContinue() ? scanWatermarkPreview(data, width, height) : null;
    const payload = preview && qredPayloadFromPhotoScanResult(data, width, height, preview);
    // A complete single-code seal can skip the expensive alignment search.
    // Navigation/ordinary QRs must not hide a watermark, and one chunk must
    // not stop recovery of a four-code page. Trust is checked by the normal
    // verification session after either decoding path returns its payload.
    if (decodeSeal(payload)?.total_chunks === 1) return { status: "found", text: payload };
    if (decodeSeal(payload)) partials.add(payload);
    // An ordinary footer code should not pay for exhaustive page alignment.
    // Allow one original-scale attempt plus a masked navigation-code retry.
    const ordinary = shouldContinue() ? scanQrImage(data, width, height,
      { tryRescaling: false, tryWatermark: false, maxAttempts: 2, shouldContinue }) : null;
    const ordinaryPayload = ordinary && qredPayloadFromPhotoScanResult(data, width, height, ordinary);
    if (decodeSeal(ordinaryPayload)?.total_chunks === 1) return { status: "found", text: ordinaryPayload };
    if (decodeSeal(ordinaryPayload)) partials.add(ordinaryPayload);
    // Isolate adjacent dark footer symbols before the expensive watermark
    // fallback. Whole-frame finder triples can span two different symbols.
    const footer = shouldContinue() ? scanFooterSeals(image, { shouldContinue }) : [];
    const footerTexts = footer.map(qredPayloadFromScanResult).filter(text => decodeSeal(text));
    for (const text of footerTexts) partials.add(text);
    const chunks = [...partials].map(decodeSeal);
    // This is a collection shortcut, not authentication. The verification
    // session still checks assembled bytes and every signature normally.
    if (footerTexts.length && chunks.every(chunk => {
      const indexes = new Set(chunks.filter(other => other.document_id === chunk.document_id
        && other.version === chunk.version && other.total_chunks === chunk.total_chunks
        && other.multipart === chunk.multipart).map(other => other.chunk_number));
      return indexes.size >= (chunk.required_chunks || chunk.total_chunks);
    })) return { status: "found-multiple", texts: [...partials] };
    // Retain the original wider alignment search for larger print distortions.
    const rectified = shouldContinue() ? scanRectifiedSeal(image, { shouldContinue }) : null;
    if (decodeSeal(rectified?.seal)?.total_chunks === 1) return { status: "found", text: rectified.seal };
    if (decodeSeal(rectified?.seal)) partials.add(rectified.seal);
    const aligned = shouldContinue() ? scanPageAlignedImage(image, { deep: true, shouldContinue }) : [];
    const texts = [...new Set([...aligned.map(result => result.seal), ...partials])];
    if (texts.length) return { status: "found-multiple", texts };
  }
  const code = shouldContinue() ? scanQrImage(data, width, height, { shouldContinue }) : null;
  if (code?.codes) return qrFrameAction(image, code, { returnPayload });
  if (!code) return { status: "feedback", message: "No readable seal found. Include all four page corners against a contrasting background, hold steady, and avoid glare. For footer seals, try framing the individual QR instead." };
  const text = qredTextFromScanResult(code);
  if (isQRedEntryLink(text)) {
    return { status: "feedback", message: "That code opens qred.org. Include the full printed page against a contrasting background for its pale watermark, or frame an individual larger footer seal." };
  }
  return qrScanAction(data, width, height, code, { returnPayload });
}
