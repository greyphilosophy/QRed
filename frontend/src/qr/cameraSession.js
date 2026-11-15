import { alternateLightCameras, applyCameraQualityControls, getPreferredCameraStream, requestCameraById } from "./cameraControls.js";
import { attachCameraLight, hasPausedTorch } from "./cameraLight.js";
import { observeCameraFrames } from "./cameraPhoto.js";

const CAMERA_ACCESS_TIMEOUT_MS = 30000;
const FIRST_FRAME_TIMEOUT_MS = 10000;
const LIGHT_LENS_TIMEOUT_MS = 2500;

// Keep the scanner session while the user changes tabs, but own a camera
// only while visible. Closing or leaving the page permanently ends the session.
export function startCameraSession(options) {
  const page = globalThis.document;
  let attempt = null, closePhonePicker = null;
  let stopped = false, paused = false, lightSearch = null, preferPhoneCamera = false, selectedId = null;
  let restoreLight = false, reopenFrame = null;

  function release() {
    attempt?.abort();
    attempt = null;
  }

  function stop() {
    stopped = true;
    unsubscribe?.();
    if (reopenFrame !== null) cancelAnimationFrame(reopenFrame);
    closePhonePicker?.();
    page?.removeEventListener("visibilitychange", updateVisibility);
    globalThis.removeEventListener?.("pagehide", stop);
    release();
  }

  function rememberLitCamera(track) {
    restoreLight = true;
    try { selectedId = track.getSettings?.().deviceId || selectedId; } catch { /* Use the preferred camera. */ }
  }

  async function openPhoneCamera() {
    if (paused || stopped || options.progress?.getSnapshot()) return;
    paused = true;
    lightSearch = null;
    release();
    // A fresh input owns a single picker result. It cannot deliver an old
    // photo to a replacement scanner or change the normal gallery picker.
    const input = page.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.setAttribute("capture", "environment");
    input.setAttribute("aria-label", "Take a page photo with the phone camera");
    input.hidden = true;
    page.body.append(input);
    let closed = false;
    async function finish(file) {
      if (closed) return;
      closed = true;
      closePhonePicker = null;
      input.remove();
      try { if (!stopped && file) await options.onPhonePhoto(file); }
      finally { paused = false; updateVisibility(); }
    }
    closePhonePicker = () => finish();
    input.addEventListener("cancel", closePhonePicker, { once: true });
    input.addEventListener("change", () => finish(input.files?.[0]), { once: true });
    try { input.click(); } catch { await finish(); }
  }
  function nextLightCamera() {
    const next = performance.now() < lightSearch.deadline ? lightSearch.alternatives.shift() : null;
    if (next) { open(next, true); return; }
    selectedId = lightSearch.activeId;
    lightSearch = null;
    preferPhoneCamera = true;
    open(selectedId);
  }
  function open(deviceId, seekingLight = false) {
    if (stopped || paused || page?.hidden) return;
    release();
    const controller = new AbortController();
    attempt = controller;
    openPreview({ ...options,
      requestStream: deviceId ? () => requestCameraById(deviceId) : options.requestStream,
      seekingLight, restoreLight, preferPhoneCamera,
      onPhoneCamera: options.onPhonePhoto ? openPhoneCamera : undefined,
      // Some drivers ignore torch:false. Ending that stream turns off its
      // light even when the controls fail. Keep decoding the captured pixels.
      onTorchStuck: track => {
        if (controller.signal.aborted) return;
        rememberLitCamera(track);
        release();
      },
      onProbeFinished: enabled => {
        restoreLight = false;
        if (enabled && seekingLight) selectedId = deviceId;
        lightSearch = null;
      },
      onLightUnavailable: async track => {
        if (restoreLight) return false;
        if (!lightSearch) {
          const found = await alternateLightCameras(track);
          if (controller.signal.aborted || options.progress?.getSnapshot()) return false;
          if (!found.alternatives.length) { preferPhoneCamera = true; return; }
          lightSearch = { ...found, deadline: performance.now() + 2 * LIGHT_LENS_TIMEOUT_MS };
        }
        if (controller.signal.aborted || options.progress?.getSnapshot()) return false;
        nextLightCamera();
      },
    }, controller.signal, (error, stage) => {
      if (!["NotAllowedError", "SecurityError"].includes(error.name)) {
        if (lightSearch) { nextLightCamera(); return; }
        // An exact device may disappear while the system camera or tab is away.
        if (deviceId) { selectedId = null; restoreLight = false; open(); return; }
      }
      stop();
      options.onError(error, stage);
    });
  }
  function updateVisibility() {
    if (page?.hidden) {
      const track = options.video.srcObject?.getVideoTracks?.()[0];
      if (hasPausedTorch(track)) rememberLitCamera(track);
      lightSearch = null; release(); return;
    }
    if (!attempt && !(restoreLight && options.progress?.getSnapshot())) open(selectedId);
  }

  const unsubscribe = options.progress?.subscribe(() => {
    if (!restoreLight || attempt || page?.hidden || options.progress.getSnapshot() || reopenFrame !== null) return;
    // Clearing progress also happens during teardown or photo replacement.
    // Recheck on the next visible frame before asking for the camera again.
    reopenFrame = requestAnimationFrame(() => { reopenFrame = null; updateVisibility(); });
  });
  page?.addEventListener("visibilitychange", updateVisibility);
  globalThis.addEventListener?.("pagehide", stop);
  updateVisibility();
  return { stop };
}

async function openPreview({ video, requestStream = signal => getPreferredCameraStream(undefined, signal),
  prepareStream = applyCameraQualityControls, lightButton, framingSelect, progress, onStream, onFrame, waitForMetadata = false, interval = 125,
  seekingLight, restoreLight, preferPhoneCamera, onProbeFinished, onLightUnavailable, onTorchStuck, onPhoneCamera },
  signal, onFailure) {
  let stream = null, animation = null, started = false, stopFrameObserver, controls;
  let waitingForLight = seekingLight || restoreLight;
  let lastScanAt = -Infinity;
  let timer = setTimeout(() => fail(new Error("Camera access did not finish. Check camera permission and try again."), "access"),
    seekingLight ? LIGHT_LENS_TIMEOUT_MS : CAMERA_ACCESS_TIMEOUT_MS);

  function fail(error, stage) {
    if (!signal.aborted) onFailure(error, stage);
  }

  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    stopFrameObserver?.();
    controls?.detach();
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
    if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (!progress?.getSnapshot()) controls?.resumeTorch();
    }
    if (!waitingForLight && performance.now() - lastScanAt >= interval) {
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
    seekingLight ? LIGHT_LENS_TIMEOUT_MS : FIRST_FRAME_TIMEOUT_MS);
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
    controls = attachCameraLight(lightButton, stream.getVideoTracks?.()[0], { video, progress, framingSelect,
      enableOnPlayback: waitingForLight, preferPhoneCamera, onPhoneCamera, onLightUnavailable, onTorchStuck,
      onProbeFinished: enabled => { waitingForLight = false; onProbeFinished(enabled); },
    });
    // The alternate's torch constraints include the same focus, exposure and
    // zoom preferences. A concurrent second request could reset its light.
    if (!seekingLight && !restoreLight) {
      try { await prepareStream?.(stream); } catch { /* The preview can continue. */ }
      if (!signal.aborted) controls?.refresh();
    }
  }
}
