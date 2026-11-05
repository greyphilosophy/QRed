// Still capture stays inside the browser. ImageCapture returns a Blob; it
// does not hand off to the phone camera app or save to the photo library.
export const NATIVE_PHOTO_TIMEOUT_MS = 5000;
export const MIN_DOCUMENT_PHOTO_PIXELS = 4_000_000;
export const MIN_DOCUMENT_PHOTO_LONG_SIDE = 2560;
const pendingTracks = new WeakSet();

export function canCaptureCameraPhoto(video) {
  const track = video?.srcObject?.getVideoTracks?.()[0];
  return typeof globalThis.ImageCapture === "function" && typeof globalThis.createImageBitmap === "function"
    && track?.kind === "video" && track.readyState === "live";
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
  return { ...action, message: `${action.message} ${source}: ${capture.width} × ${capture.height}.${reason ? ` ${reason}` : ""}` };
}

const unsupportedOptions = error => ["NotSupportedError", "OverconstrainedError", "TypeError"].includes(error?.name);

export async function captureCameraPhoto(video, canvas, { signal, timeoutMs = NATIVE_PHOTO_TIMEOUT_MS, onDiagnostic,
  requireHighResolution = false } = {}) {
  signal?.throwIfAborted();
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
  let active = true, timer, abort;
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
      const settings = { fillLightMode: "off" };
      const width = capabilities?.imageWidth, height = capabilities?.imageHeight;
      if (width?.max > 0 && height?.max > 0) {
        const scale = Math.min(1, Math.sqrt(12_000_000 / (width.max * height.max)));
        settings.imageWidth = Math.max(width.min || 1, Math.floor(width.max * scale));
        settings.imageHeight = Math.max(height.min || 1, Math.floor(height.max * scale));
      }
      let blob;
      try { blob = await camera.takePhoto(settings); }
      catch (error) {
        // Some devices advertise dimensions they reject together. Retry once
        // without optional sizing, still with flash off, inside the SAME timer.
        if (!active || signal?.aborted || !settings.imageWidth || !unsupportedOptions(error)) throw error;
        blob = await camera.takePhoto({ fillLightMode: "off" });
      }
      if (!active || signal?.aborted) return fallback("capture-failed");
      bitmap = await createImageBitmap(blob);
      if (!active || signal?.aborted) return fallback("capture-failed");
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 80_000_000)
        return fallback("invalid-photo");
      if (requireHighResolution && !hasDocumentPhotoDetail(bitmap.width, bitmap.height))
        return { image: null, diagnostic: { source: "native-still", width: bitmap.width, height: bitmap.height, reason: "low-resolution" } };
      if (!requireHighResolution && bitmap.width * bitmap.height < canvas.width * canvas.height) return fallback("smaller-photo");
      const scale = Math.min(1, Math.sqrt(12_000_000 / (bitmap.width * bitmap.height)));
      const widthPixels = Math.round(bitmap.width * scale), heightPixels = Math.round(bitmap.height * scale);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return fallback("invalid-photo");
      replacingFrame = true;
      canvas.width = widthPixels; canvas.height = heightPixels;
      context.drawImage(bitmap, 0, 0, widthPixels, heightPixels);
      return { image: context.getImageData(0, 0, widthPixels, heightPixels),
        diagnostic: { source: "native-still", width: widthPixels, height: heightPixels, reason: "captured" } };
    } catch (error) {
      // Once replacing the retained canvas begins, a drawing failure must
      // surface instead of pairing old decoder pixels with a different photo.
      if (replacingFrame) throw error;
      // Unsupported/rejected still capture retains the already frozen preview.
      return fallback("capture-failed");
    } finally { bitmap?.close(); pendingTracks.delete(track); }
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
    return result.image;
  } finally {
    active = false; clearTimeout(timer); signal?.removeEventListener("abort", abort);
  }
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
    const scale = Math.min(1, Math.sqrt(12_000_000 / (width * height)));
    const widthPixels = Math.round(width * scale), heightPixels = Math.round(height * scale);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return failure("invalid-photo");
    // As with native capture, do not fall back to old pixels if drawing fails.
    canvas.width = widthPixels; canvas.height = heightPixels;
    context.drawImage(photo, 0, 0, widthPixels, heightPixels);
    const image = context.getImageData(0, 0, widthPixels, heightPixels);
    onDiagnostic?.({ source: "selected-photo", width: widthPixels, height: heightPixels, reason: "captured" });
    return image;
  } finally {
    signal?.removeEventListener("abort", abort);
    photo.src = ""; URL.revokeObjectURL(url);
  }
}
