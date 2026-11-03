// Still capture stays inside the browser. ImageCapture returns a Blob; it
// does not hand off to the phone camera app or save to the photo library.
export function canCaptureCameraPhoto(video) {
  const track = video?.srcObject?.getVideoTracks?.()[0];
  return typeof globalThis.ImageCapture === "function" && typeof globalThis.createImageBitmap === "function"
    && track?.kind === "video" && track.readyState === "live";
}

export async function captureCameraPhoto(video, canvas, { signal, timeoutMs = 1800 } = {}) {
  signal?.throwIfAborted();
  if (!canCaptureCameraPhoto(video)) return null;
  let active = true, timer, abort;
  const attempt = async () => {
    let bitmap, replacingFrame = false;
    try {
      const camera = new ImageCapture(video.srcObject.getVideoTracks()[0]);
      const capabilities = await camera.getPhotoCapabilities();
      if (!active || signal?.aborted) return null;
      const settings = { fillLightMode: "off" };
      const width = capabilities.imageWidth, height = capabilities.imageHeight;
      if (width?.max > 0 && height?.max > 0) {
        const scale = Math.min(1, Math.sqrt(12_000_000 / (width.max * height.max)));
        settings.imageWidth = Math.max(width.min || 1, Math.floor(width.max * scale));
        settings.imageHeight = Math.max(height.min || 1, Math.floor(height.max * scale));
      }
      const blob = await camera.takePhoto(settings);
      if (!active || signal?.aborted) return null;
      bitmap = await createImageBitmap(blob);
      if (!active || signal?.aborted || !bitmap.width || !bitmap.height
        || bitmap.width * bitmap.height > 80_000_000) return null;
      if (bitmap.width * bitmap.height < canvas.width * canvas.height) return null;
      const scale = Math.min(1, Math.sqrt(12_000_000 / (bitmap.width * bitmap.height)));
      const widthPixels = Math.round(bitmap.width * scale), heightPixels = Math.round(bitmap.height * scale);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return null;
      replacingFrame = true;
      canvas.width = widthPixels; canvas.height = heightPixels;
      context.drawImage(bitmap, 0, 0, widthPixels, heightPixels);
      return context.getImageData(0, 0, widthPixels, heightPixels);
    } catch (error) {
      // Once replacing the retained canvas begins, a drawing failure must
      // surface instead of pairing old decoder pixels with a different photo.
      if (replacingFrame) throw error;
      // Unsupported/rejected still capture retains the already frozen preview.
      return null;
    } finally { bitmap?.close(); }
  };
  try {
    return await Promise.race([
      attempt(),
      new Promise(resolve => { timer = setTimeout(() => { active = false; resolve(null); }, timeoutMs); }),
      new Promise((_, reject) => {
        abort = () => { active = false; reject(new DOMException("Capture cancelled", "AbortError")); };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    active = false; clearTimeout(timer); signal?.removeEventListener("abort", abort);
  }
}
