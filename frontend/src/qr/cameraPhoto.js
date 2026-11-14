// Still capture stays inside the browser. ImageCapture returns a Blob; it
// does not hand off to the phone camera app or save to the photo library.
import { stillPhotoLighting } from "./cameraLight.js";
export const NATIVE_PHOTO_TIMEOUT_MS = 5000;
export const MIN_DOCUMENT_PHOTO_PIXELS = 4_000_000;
export const MIN_DOCUMENT_PHOTO_LONG_SIDE = 2560;
const MAX_GUIDANCE_SIDE = 1280;
const MAX_WORKING_PHOTO_PIXELS = 12_000_000;
const pendingTracks = new WeakSet();
const lastGuidanceFrame = new WeakMap();
const deliveredFrames = new WeakMap();
const GUIDE_LABELS = Object.freeze({
  framing: "page corners needed", small: "page too small", dark: "more light needed",
  soft: "page edges soft", clear: "page clear", hold: "steady hold pending",
  ready: "steady hold passed", captured: "page already captured",
});

// Snapshot only the last guidance state and actual preview dimensions before
// a native photo replaces the canvas. The later live view is a different frame.
export function cameraCaptureContext(frame, automatic, quality) {
  return {
    trigger: automatic ? "automatic" : "manual",
    ...(Number.isInteger(frame?.width) && Number.isInteger(frame?.height)
      && frame.width > 0 && frame.height > 0 && frame.width * frame.height <= 80_000_000
      ? { previewWidth: frame.width, previewHeight: frame.height } : {}),
    ...(typeof quality?.state === "string" && Object.hasOwn(GUIDE_LABELS, quality.state)
      ? { guideState: quality.state } : {}),
  };
}

export function canCaptureCameraPhoto(video) {
  const track = video?.srcObject?.getVideoTracks?.()[0];
  return typeof globalThis.ImageCapture === "function" && typeof globalThis.createImageBitmap === "function"
    && track?.kind === "video" && track.readyState === "live";
}

// The compositor can drop most screen repaints while the media source keeps
// delivering frames. A media timestamp advances only on a fresh video frame.
export function observeCameraFrames(video, stream) {
  if (typeof video.requestVideoFrameCallback !== "function") return;
  const frame = { stream, time: null };
  const onFrame = (_, metadata) => {
    if (deliveredFrames.get(video) !== frame) return;
    frame.time = metadata.mediaTime;
    request = video.requestVideoFrameCallback(onFrame);
  };
  let request = video.requestVideoFrameCallback(onFrame);
  deliveredFrames.set(video, frame);
  return () => {
    if (deliveredFrames.get(video) === frame) deliveredFrames.delete(video);
    video.cancelVideoFrameCallback?.(request);
  };
}

// Document guidance uses a smaller video frame. The camera supplies a separate
// high-resolution still for seal recovery and printed-text comparison.
export function readCameraFrame(video, canvas, { forGuidance = false } = {}) {
  const sourceWidth = video.videoWidth, sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return null;
  // The media clock and animation loop can advance while a camera keeps
  // displaying one frame. Count a delivered preview only once.
  let frame;
  if (forGuidance) {
    const delivered = deliveredFrames.get(video);
    if (delivered && delivered.stream === video.srcObject) {
      if (delivered.time === null) return null;
      frame = delivered.time;
    } else {
      const playback = video.getVideoPlaybackQuality?.();
      if (playback?.totalVideoFrames > 0) frame = playback.totalVideoFrames - (playback.droppedVideoFrames || 0);
    }
    const previous = lastGuidanceFrame.get(video);
    if (frame !== undefined && previous?.count === frame && previous.stream === video.srcObject) return null;
  }
  const scale = forGuidance ? Math.min(1, MAX_GUIDANCE_SIDE / Math.max(sourceWidth, sourceHeight)) : 1;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(video, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  if (frame !== undefined) lastGuidanceFrame.set(video, { count: frame, stream: video.srcObject });
  return pixels;
}

// Only dimensions and a fixed reason code leave the capture helper. Never
// include camera/device identifiers, exception text, document data or pixels.
export function cameraFrameDiagnostic(frame, reason = "unsupported") {
  return { source: "video-frame", width: frame.width, height: frame.height, reason };
}

export function cameraCaptureFeedback(action, capture) {
  if (action.captureFailed || !capture || (!action.timedOut && action.status !== "feedback") || !action.message
    || !Number.isInteger(capture.width) || !Number.isInteger(capture.height)
    || capture.width <= 0 || capture.height <= 0) return action;
  const reasons = {
    unsupported: "Still photos are unavailable in this browser.",
    timeout: "Still photo capture timed out.",
    "capture-failed": "Still photo capture failed.",
    "smaller-photo": "The still photo had less detail than the camera frame.",
    "invalid-photo": "The still photo could not be used.",
  };
  const source = capture.source === "native-still" ? "Camera photo"
    : capture.source === "selected-photo" ? "Selected photo" : "Camera frame";
  const reason = capture.source === "video-frame" ? reasons[capture.reason] : null;
  const details = [];
  if (Number.isInteger(capture.exposures) && capture.exposures >= 2 && capture.exposures <= 3)
    details.push(`${capture.exposures} exposures`);
  if (Number.isInteger(capture.sourceWidth) && Number.isInteger(capture.sourceHeight)
    && capture.sourceWidth > 0 && capture.sourceHeight > 0 && capture.sourceWidth * capture.sourceHeight <= 80_000_000
    && (capture.sourceWidth !== capture.width || capture.sourceHeight !== capture.height))
    details.push(`from ${capture.sourceWidth} × ${capture.sourceHeight}`);
  if (Number.isFinite(capture.preparationMs) && capture.preparationMs >= 0 && capture.preparationMs <= 600_000)
    details.push(`prepared in ${(capture.preparationMs / 1000).toFixed(1)} s`);
  const context = [];
  if (["manual", "automatic"].includes(capture.trigger)) context.push(`${capture.trigger} capture`);
  if (Number.isInteger(capture.previewWidth) && Number.isInteger(capture.previewHeight)
    && capture.previewWidth > 0 && capture.previewHeight > 0 && capture.previewWidth * capture.previewHeight <= 80_000_000)
    context.push(`${capture.previewWidth} × ${capture.previewHeight} preview`);
  if (typeof capture.guideState === "string" && Object.hasOwn(GUIDE_LABELS, capture.guideState))
    context.push(`last guide: ${GUIDE_LABELS[capture.guideState]}`);
  return { ...action, message: `${action.message} ${source}: ${capture.width} × ${capture.height}${details.length ? ` (${details.join(", ")})` : ""}.${context.length ? ` Before photo: ${context.join(", ")}.` : ""}${reason ? ` ${reason}` : ""}` };
}

const unsupportedOptions = error => ["NotSupportedError", "OverconstrainedError", "TypeError"].includes(error?.name);

function workingPhotoSize(width, height) {
  const scale = Math.min(1, Math.sqrt(MAX_WORKING_PHOTO_PIXELS / (width * height)));
  // Rounding up can exceed the decoder's pixel limit.
  return { width: Math.floor(width * scale), height: Math.floor(height * scale) };
}

function readPhotoPixels(photo, canvas, context, source, started) {
  const sourceWidth = photo.naturalWidth ?? photo.width;
  const sourceHeight = photo.naturalHeight ?? photo.height;
  const { width, height } = workingPhotoSize(sourceWidth, sourceHeight);
  canvas.width = width; canvas.height = height;
  context.drawImage(photo, 0, 0, width, height);
  const image = context.getImageData(0, 0, width, height);
  return { image, diagnostic: { source, width, height, sourceWidth, sourceHeight,
    preparationMs: Math.round(performance.now() - started), reason: "captured" } };
}

export async function captureCameraPhoto(video, canvas, { signal, timeoutMs = NATIVE_PHOTO_TIMEOUT_MS, onDiagnostic, onPhotoBlob, onPhotoTaken, onBurst,
  requireHighResolution = false } = {}) {
  signal?.throwIfAborted();
  const started = performance.now();
  const fallback = reason => ({ image: null, diagnostic: cameraFrameDiagnostic(canvas, reason) });
  if (!canCaptureCameraPhoto(video)) {
    onDiagnostic?.(fallback("unsupported").diagnostic);
    return null;
  }
  const track = video.srcObject.getVideoTracks()[0];
  if (pendingTracks.has(track)) {
    onDiagnostic?.(fallback("camera-busy").diagnostic);
    return null;
  }
  pendingTracks.add(track);
  let active = true, timer, abort, shutterInFlight;
  const attempt = async () => {
    let bitmap, replacingFrame = false;
    try {
      const camera = new ImageCapture(track);
      let capabilities;
      try { capabilities = await camera.getPhotoCapabilities?.(); }
      catch (error) {
        // Optional capability discovery must not prevent a supported still.
        // Do not retry permission/security or other camera failures.
        if (!unsupportedOptions(error)) throw error;
      }
      if (!active || signal?.aborted) return fallback("capture-failed");
      const lighting = await stillPhotoLighting(track);
      if (!active || signal?.aborted) return fallback("capture-failed");
      let settings = { ...lighting };
      const width = capabilities?.imageWidth, height = capabilities?.imageHeight;
      if (width?.max > 0 && height?.max > 0) {
        const size = workingPhotoSize(width.max, height.max);
        settings.imageWidth = Math.max(width.min || 1, size.width);
        settings.imageHeight = Math.max(height.min || 1, size.height);
      }
      let blob;
      try { blob = await camera.takePhoto(settings); }
      catch (error) {
        // Some devices advertise dimensions they reject together. Retry once
        // without optional sizing, preserving the light choice and deadline.
        if (!active || signal?.aborted || !settings.imageWidth || !unsupportedOptions(error)) throw error;
        settings = lighting;
        blob = await camera.takePhoto(settings);
      }
      if (!active || signal?.aborted) return fallback("capture-failed");
      // Keep the first original for OCR and saving. Additional stills may
      // help read its seal, but a slow or rejected shutter must not lose it.
      const extras = [];
      const burstCapable = blob?.size && onBurst && typeof OffscreenCanvas === "function";
      if (burstCapable) {
        const until = Math.min(performance.now() + 1100, started + timeoutMs - 1200);
        while (extras.length < 2 && active && !signal?.aborted && track.readyState === "live"
          && video.srcObject?.getVideoTracks?.()[0] === track && performance.now() < until) {
          let stopWaiting;
          try {
            shutterInFlight = camera.takePhoto(settings);
            const extra = await Promise.race([shutterInFlight, new Promise(resolve => {
              stopWaiting = setTimeout(() => resolve(null), Math.max(0, until - performance.now()));
            })]);
            if (!extra?.size) break;
            extras.push(extra);
          } catch { break; }
          finally { clearTimeout(stopWaiting); }
        }
      }
      if (!active || signal?.aborted) return fallback("capture-failed");
      // No more exposures will be used after this point.
      if (blob?.size) onPhotoTaken?.();
      bitmap = await createImageBitmap(blob);
      if (!active || signal?.aborted) return fallback("capture-failed");
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 80_000_000)
        return fallback("invalid-photo");
      if (requireHighResolution && !hasDocumentPhotoDetail(bitmap.width, bitmap.height))
        return { image: null, diagnostic: { source: "native-still", width: bitmap.width, height: bitmap.height, reason: "low-resolution" } };
      if (!requireHighResolution && bitmap.width * bitmap.height < canvas.width * canvas.height) return fallback("smaller-photo");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return fallback("invalid-photo");
      replacingFrame = true;
      const captured = readPhotoPixels(bitmap, canvas, context, "native-still", started);
      if (burstCapable) captured.diagnostic.exposures = 1 + extras.length;
      return { ...captured, blob, extras };
    } catch (error) {
      // Once replacing the retained canvas begins, a drawing failure must
      // surface instead of pairing old decoder pixels with a different photo.
      if (replacingFrame) throw error;
      // Unsupported/rejected still capture retains the already frozen preview.
      return fallback("capture-failed");
    } finally {
      bitmap?.close();
      if (shutterInFlight) Promise.resolve(shutterInFlight).catch(() => {}).then(() => pendingTracks.delete(track));
      else pendingTracks.delete(track);
    }
  };
  try {
    const result = await Promise.race([
      attempt(),
      new Promise(resolve => { timer = setTimeout(() => { active = false; resolve(fallback("timeout")); }, timeoutMs); }),
      new Promise((_, reject) => {
        abort = () => { active = false; reject(new DOMException("Capture cancelled", "AbortError")); };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
    signal?.throwIfAborted();
    onDiagnostic?.(result.diagnostic);
    if (result.image) {
      onPhotoBlob?.(result.blob);
      if (result.extras?.length) onBurst(result.extras);
    }
    return result.image;
  } finally {
    active = false; clearTimeout(timer); signal?.removeEventListener("abort", abort);
  }
}

// The user can keep the exact camera file after a failed read. Creating the
// download only on a click keeps the photo in memory until the user chooses.
export function downloadCameraPhoto(blob) {
  const extensions = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
    "image/avif": ".avif", "image/heic": ".heic", "image/heif": ".heif" };
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url;
  link.download = "QRed-scan-photo" + (extensions[blob.type] || "");
  document.body.appendChild(link);
  try { link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

// An operational floor for a full-page photograph, not a readability verdict.
// The smallest successful measured full-page replay was 2560 on its long side;
// the area floor also excludes narrow crops. The capture target remains 12 MP.
export function hasDocumentPhotoDetail(width, height) {
  return Number.isInteger(width) && Number.isInteger(height)
    && Math.max(width, height) >= MIN_DOCUMENT_PHOTO_LONG_SIDE
    && width * height >= MIN_DOCUMENT_PHOTO_PIXELS;
}

export function cameraPhotoFailure(diagnostic) {
  const reasons = {
    unsupported: "This browser cannot take a full-resolution camera photo.",
    timeout: "The camera did not finish taking its photo in time.",
    "camera-busy": "The camera is still finishing its previous photo.",
    "capture-failed": "The camera could not take a photo.",
    "invalid-photo": "The photo could not be opened at a usable size.",
    "smaller-photo": "The camera returned a smaller photo than expected.",
    "low-resolution": "The photo is too small for automatic full-page capture (at least 4 MP and 2560 pixels on the long side).",
  };
  return { status: "feedback", captureFailed: true,
    message: `${reasons[diagnostic?.reason] || reasons["capture-failed"]} Retry Capture now or choose a high-resolution photo. No video frame was scanned.` };
}

// Explicit local photo selection is the compatibility path. It does not open
// the phone's camera app automatically, persist the file or send it anywhere.
export async function readCameraPhotoFile(file, canvas, { signal, onDiagnostic, requireHighResolution = true } = {}) {
  signal?.throwIfAborted();
  const started = performance.now();
  const photo = new Image(), url = URL.createObjectURL(file);
  let abort;
  const failure = reason => {
    onDiagnostic?.({ source: "selected-photo", width: photo.naturalWidth, height: photo.naturalHeight, reason });
    return null;
  };
  try {
    photo.src = url;
    try {
      await Promise.race([photo.decode(), new Promise((_, reject) => {
        abort = () => reject(new DOMException("Photo selection cancelled", "AbortError"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      })]);
    } catch {
      signal?.throwIfAborted();
      return failure("invalid-photo");
    }
    signal?.throwIfAborted();
    const width = photo.naturalWidth, height = photo.naturalHeight;
    if (!width || !height || width * height > 80_000_000) return failure("invalid-photo");
    if (requireHighResolution && !hasDocumentPhotoDetail(width, height)) return failure("low-resolution");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return failure("invalid-photo");
    // As with native capture, do not fall back to old pixels if drawing fails.
    const { image, diagnostic } = readPhotoPixels(photo, canvas, context, "selected-photo", started);
    onDiagnostic?.(diagnostic);
    return image;
  } finally {
    signal?.removeEventListener("abort", abort);
    photo.src = ""; URL.revokeObjectURL(url);
  }
}
