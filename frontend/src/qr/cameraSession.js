import { applyCameraQualityControls, getPreferredCameraStream } from "./cameraControls.js";
import { attachCameraLight } from "./cameraLight.js";
import { observeCameraFrames } from "./cameraPhoto.js";

const CAMERA_ACCESS_TIMEOUT_MS = 30000;
const FIRST_FRAME_TIMEOUT_MS = 10000;

// Keep the scanner session while the user changes tabs, but own a camera
// only while visible. Closing or leaving the page permanently ends the session.
export function startCameraSession(options) {
  const page = globalThis.document;
  let attempt = null;

  function release() {
    attempt?.abort();
    attempt = null;
  }

  function stop() {
    page?.removeEventListener("visibilitychange", updateVisibility);
    globalThis.removeEventListener?.("pagehide", stop);
    release();
  }

  function updateVisibility() {
    if (page?.hidden) { release(); return; }
    if (attempt) return;
    attempt = new AbortController();
    openPreview(options, attempt.signal, (error, stage) => {
      stop();
      options.onError(error, stage);
    });
  }

  page?.addEventListener("visibilitychange", updateVisibility);
  globalThis.addEventListener?.("pagehide", stop);
  updateVisibility();
  return { stop };
}

async function openPreview({ video, requestStream = signal => getPreferredCameraStream(undefined, signal),
  prepareStream = applyCameraQualityControls, lightButton, onStream, onFrame, waitForMetadata = false, interval = 125 },
  signal, onFailure) {
  let stream = null, animation = null, started = false, stopFrameObserver, detachLight;
  let lastScanAt = -Infinity;
  let timer = setTimeout(() => fail(new Error("Camera access did not finish. Check camera permission and try again."), "access"),
    CAMERA_ACCESS_TIMEOUT_MS);

  function fail(error, stage) {
    if (!signal.aborted) onFailure(error, stage);
  }

  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    stopFrameObserver?.();
    detachLight?.();
    if (animation !== null) cancelAnimationFrame(animation);
    if (video.onloadedmetadata === startFrames) video.onloadedmetadata = null;
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      if (video.srcObject === stream) video.srcObject = null;
      stream = null;
      onStream?.(null);
    }
  }, { once: true });

  function tick() {
    if (signal.aborted) return;
    if (timer !== null && video.readyState >= 2 && video.videoWidth && video.videoHeight) {
      clearTimeout(timer);
      timer = null;
    }
    if (performance.now() - lastScanAt >= interval) {
      try { onFrame(); } catch (error) { fail(error, "frame"); return; }
      // Count from completion so expensive decoding still yields to input.
      lastScanAt = performance.now();
    }
    if (!signal.aborted) animation = requestAnimationFrame(tick);
  }

  function startFrames() {
    if (signal.aborted || started) return;
    started = true;
    tick();
  }

  try {
    const acquired = await requestStream(signal);
    if (signal.aborted) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired;
  } catch (error) { fail(error, "access"); return; }

  clearTimeout(timer);
  timer = setTimeout(() => fail(new Error("The camera opened but did not deliver a preview. Try the camera again or choose a photo."), "play"),
    FIRST_FRAME_TIMEOUT_MS);
  try {
    if (waitForMetadata) video.onloadedmetadata = startFrames;
    video.muted = true;
    video.srcObject = stream;
    stopFrameObserver = observeCameraFrames(video, stream);
    onStream?.(stream);
    video.play()?.catch(error => fail(error, "play"));
    if (!waitForMetadata || video.readyState >= 1) startFrames();
  } catch (error) { fail(error, "play"); return; }

  // Some camera drivers wait for playback before applying focus or zoom.
  // These controls are optional and must never gate the preview or frame loop.
  if (!signal.aborted) {
    detachLight = attachCameraLight(lightButton, stream.getVideoTracks?.()[0]);
    try { await prepareStream?.(stream); } catch { /* The preview can continue. */ }
  }
}
