// Still capture stays inside the browser. ImageCapture returns a Blob; it
// does not hand off to the phone camera app or save to the photo library.
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
  if (!capture || (!action.timedOut && action.status !== "feedback") || !action.message
    || !Number.isInteger(capture.width) || !Number.isInteger(capture.height)
    || capture.width <= 0 || capture.height <= 0) return action;
  const reasons = {
    unsupported: "Still photos are unavailable in this browser.",
    timeout: "Still photo capture timed out.",
    "capture-failed": "Still photo capture failed.",
    "smaller-photo": "The still photo had less detail than the camera frame.",
    "invalid-photo": "The still photo could not be used.",
  };
  const source = capture.source === "native-still" ? "Camera photo" : "Camera frame";
  const reason = capture.source === "video-frame" ? reasons[capture.reason] : null;
  return { ...action, message: `${action.message} ${source}: ${capture.width} × ${capture.height}.${reason ? ` ${reason}` : ""}` };
}

const unsupportedOptions = error => ["NotSupportedError", "OverconstrainedError", "TypeError"].includes(error?.name);

export async function captureCameraPhoto(video, canvas, { signal, timeoutMs = 1800, onDiagnostic } = {}) {
  signal?.throwIfAborted();
  const fallback = reason => ({ image: null, diagnostic: cameraFrameDiagnostic(canvas, reason) });
  if (!canCaptureCameraPhoto(video)) {
    onDiagnostic?.(fallback("unsupported").diagnostic);
    return null;
  }
  let active = true, timer, abort;
  const attempt = async () => {
    let bitmap, replacingFrame = false;
    try {
      const camera = new ImageCapture(video.srcObject.getVideoTracks()[0]);
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
      if (bitmap.width * bitmap.height < canvas.width * canvas.height) return fallback("smaller-photo");
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
    } finally { bitmap?.close(); }
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
