import { scanQrImage, scanWatermarkPreview } from "./scanQrImage.js";
import { scanPageAlignedImage } from "./pageAlignedScan.js";
import { isQRedEntryLink } from "./hiddenPayload.js";
import { decodeSeal, VISIBLE_QR_TEXT, qredTextFromPhotoScanResult, qredPayloadFromPhotoScanResult,
  qredTextFromScanResult } from "../qredVerifier.js";

export function qrScanAction(data, width, height, code, { returnPayload = false } = {}) {
  if (!code?.data) return { status: "continue" };
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
export function decodePhoto(image, { returnPayload = false } = {}) {
  const { data, width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || width * height > 80_000_000 || data?.length !== width * height * 4) {
    throw new Error("This photo cannot be scanned at its current size. Choose a smaller photo.");
  }
  if (returnPayload) {
    const preview = scanWatermarkPreview(data, width, height);
    const payload = preview && qredPayloadFromPhotoScanResult(data, width, height, preview);
    // A complete single-code seal can skip the expensive alignment search.
    // Navigation/ordinary QRs must not hide a watermark, and one chunk must
    // not stop recovery of a four-code page. Trust is checked by the normal
    // verification session after either decoding path returns its payload.
    if (decodeSeal(payload)?.total_chunks === 1) return { status: "found", text: payload };
    const aligned = scanPageAlignedImage(image, { deep: true });
    if (aligned.length) return { status: "found-multiple", texts: aligned.map(result => result.seal) };
  }
  const code = scanQrImage(data, width, height);
  if (code?.codes) return qrFrameAction(image, code, { returnPayload });
  if (!code?.data) return { status: "feedback", message: "No readable seal found. Include all four page corners against a contrasting background, hold steady, and avoid glare. For older seals, try framing the individual QR instead." };
  if (code.data === VISIBLE_QR_TEXT || /QRED[34]:/.test(code.data)
    || isQRedEntryLink(code.data) || code.data.includes("qred.org")) {
    const text = returnPayload
      ? qredPayloadFromPhotoScanResult(data, width, height, code)
      : qredTextFromPhotoScanResult(data, width, height, code);
    if (text && !isQRedEntryLink(text)) return { status: "found", text };
    if (isQRedEntryLink(text) && code.data !== VISIBLE_QR_TEXT) {
      return { status: "feedback", message: "That code opens qred.org. Include the full printed page against a contrasting background to recover its pale watermark." };
    }
    if (code.data === VISIBLE_QR_TEXT) return { status: "feedback", message: "QR code found, but no hidden QRed payload was detected. Move closer, improve lighting, and try again." };
    return { status: "found", text: qredTextFromScanResult(code) };
  }
  return qrScanAction(data, width, height, code, { returnPayload });
}
