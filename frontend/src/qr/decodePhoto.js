import { PHOTO_SCAN_BUDGET_MS } from "./photoScanBudget.js";
import { scanQrImage, scanWatermarkPreview } from "./scanQrImage.js";
import { scanPageAlignedImage } from "./pageAlignedScan.js";
import { scanFooterSeals } from "./footerSealScan.js";
import { createRectifiedSealScanner } from "./rectifiedSealScan.js";
import { isQRedEntryLink, qredPayloadFromScanResult } from "./qrPayload.js";
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
// Browser callers run this synchronous work in photoScan.worker.js.
export function decodePhoto(image, { returnPayload = false, maxDurationMs = PHOTO_SCAN_BUDGET_MS,
  onProgress, onStage } = {}) {
  const { data, width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || width * height > 80_000_000 || data?.length !== width * height * 4) {
    throw new Error("This photo cannot be scanned at its current size. Choose a smaller photo.");
  }
  // Cooperatively stop between bounded attempts. A miss must return retake
  // guidance instead of spending a minute exhausting layout guesses.
  const started = performance.now(), deadline = started + maxDurationMs;
  const shouldContinue = () => performance.now() < deadline;
  // Report only fixed stage names and elapsed time, never document pixels,
  // decoded text or seal bytes. The caller can retain the last checkpoint
  // even if its watchdog has to terminate synchronous decoding mid-attempt.
  const attempt = (stage, run) => {
    onStage?.({ stage, elapsedMs: Math.max(0, Math.round(performance.now() - started)) });
    return run();
  };
  const partials = new Set();
  const keepPartial = seal => {
    if (!decodeSeal(seal) || partials.has(seal)) return;
    partials.add(seal);
    // Checkpoint recovered chunks before another synchronous attempt. The
    // worker watchdog can then stop a slow miss without losing useful data.
    onProgress?.({ status: "found-multiple", texts: [...partials] });
  };
  if (returnPayload) {
    // Try the measured whole-page grid before general-purpose QR location.
    // Reserve half the cooperative budget for other layouts if this misses.
    const scanRectified = createRectifiedSealScanner(image);
    const fastDeadline = started + maxDurationMs / 2;
    const fast = attempt("rectified-fast", () => scanRectified({
      searchRadius: 12, shouldContinue: () => performance.now() < fastDeadline,
    }));
    if (decodeSeal(fast?.seal)?.total_chunks === 1) return { status: "found", text: fast.seal };
    keepPartial(fast?.seal);
    const preview = shouldContinue() ? attempt("watermark-preview", () => scanWatermarkPreview(data, width, height)) : null;
    const payload = preview && qredPayloadFromPhotoScanResult(data, width, height, preview);
    // A complete single-code seal can skip the expensive alignment search.
    // Navigation/ordinary QRs must not hide a watermark, and one chunk must
    // not stop recovery of a four-code page. Trust is checked by the normal
    // verification session after either decoding path returns its payload.
    if (decodeSeal(payload)?.total_chunks === 1) return { status: "found", text: payload };
    keepPartial(payload);
    // An ordinary footer code should not pay for exhaustive page alignment.
    // Allow one original-scale attempt plus a masked navigation-code retry.
    const ordinary = shouldContinue() ? attempt("ordinary-qr", () => scanQrImage(data, width, height,
      { tryRescaling: false, tryWatermark: false, maxAttempts: 2, shouldContinue })) : null;
    const ordinaryPayload = ordinary && qredPayloadFromPhotoScanResult(data, width, height, ordinary);
    if (decodeSeal(ordinaryPayload)?.total_chunks === 1) return { status: "found", text: ordinaryPayload };
    keepPartial(ordinaryPayload);
    // Isolate adjacent dark footer symbols before the expensive watermark
    // fallback. Whole-frame finder triples can span two different symbols.
    const footer = shouldContinue() ? attempt("footer", () => scanFooterSeals(image, { shouldContinue, onSeal: keepPartial })) : [];
    const footerTexts = footer.map(qredPayloadFromScanResult).filter(text => decodeSeal(text));
    for (const text of footerTexts) keepPartial(text);
    const chunks = [...partials].map(decodeSeal);
    // This is a collection shortcut, not authentication. The verification
    // session still checks assembled bytes and every signature normally.
    if (footerTexts.length && chunks.every(chunk => {
      const indexes = new Set(chunks.filter(other => other.document_id === chunk.document_id
        && other.version === chunk.version && other.total_chunks === chunk.total_chunks
        && other.multipart === chunk.multipart).map(other => other.chunk_number));
      return indexes.size === chunk.total_chunks;
    })) return { status: "found-multiple", texts: [...partials] };
    // Retain the original wider alignment search for larger print distortions.
    const rectified = shouldContinue() ? attempt("rectified-wide", () => scanRectified({ shouldContinue })) : null;
    if (decodeSeal(rectified?.seal)?.total_chunks === 1) return { status: "found", text: rectified.seal };
    keepPartial(rectified?.seal);
    const aligned = shouldContinue() ? attempt("page-aligned", () => scanPageAlignedImage(image,
      { deep: true, shouldContinue, onSeal: keepPartial })) : [];
    const texts = [...new Set([...aligned.map(result => result.seal), ...partials])];
    if (texts.length) return { status: "found-multiple", texts };
  }
  const code = shouldContinue() ? attempt("general-qr", () => scanQrImage(data, width, height, { shouldContinue })) : null;
  if (code?.codes) return qrFrameAction(image, code, { returnPayload });
  if (!code) return { status: "feedback", message: "No readable seal found. Include all four page corners against a contrasting background, hold steady, and avoid glare. For footer seals, try framing the individual QR instead." };
  const text = qredTextFromScanResult(code);
  if (isQRedEntryLink(text)) {
    return { status: "feedback", message: "That code opens qred.org. Include the full printed page against a contrasting background for its pale watermark, or frame an individual larger footer seal." };
  }
  return qrScanAction(data, width, height, code, { returnPayload });
}
