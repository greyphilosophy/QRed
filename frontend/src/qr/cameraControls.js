import { cameraZoomRange } from "./cameraFraming.js";
import { forgetPreferredCamera, preferredCameraId } from "./cameraPreference.js";
import { inspectCameraCapabilities, requestInspectionStream } from "./cameraInspection.js";

// A successful automatic inspection can be reused during this page visit.
// A fresh visit still chooses a camera without needing a saved preference.
const inspectedCameras = new WeakMap();

function cameraScore(label, capabilities = {}) {
  const autofocus = capabilities?.focusMode?.includes?.("continuous");
  const light = capabilities?.torch === true || capabilities?.torch?.includes?.(true);
  return /main|primary|\b1(?:\.0+)?x\b/i.test(label) ? 5
    : autofocus && light ? 4 : autofocus ? 3 : light ? 2 : /wide/i.test(label) ? 1 : 0;
}

function cameraId(stream) {
  try { return stream?.getVideoTracks?.()[0]?.getSettings?.().deviceId; } catch { return undefined; }
}

function permissionDenied(error) {
  return error.name === "NotAllowedError" || error.name === "SecurityError";
}

export const QR_CAMERA_CONSTRAINTS = {
  video: {
    facingMode: { ideal: "environment" },
    // Dense full-page seals need more detail than a 1080p preview. These are
    // preferences, so cameras with lower limits can still open normally.
    width: { ideal: 3840 },
    height: { ideal: 2880 },
  },
};

function documentCameras(devices) {
  const rear = [];
  for (const device of devices) {
    if (device.kind !== "videoinput" || !device.deviceId) continue;
    const label = device.label || "";
    if (/front|selfie|user[- ]facing|ultra|telephoto|zoom|macro|depth|\b(?:[2-9]|\d{2,})(?:\.\d+)?\s*[x×]|\b0\.\d+\s*[x×]/i.test(label)) continue;
    let capabilities;
    try { capabilities = device.getCapabilities?.(); } catch { /* Optional after camera permission. */ }
    const rearFacing = capabilities?.facingMode?.includes("environment");
    if ((!rearFacing && capabilities?.facingMode?.includes("user")) ||
        (!rearFacing && !/back|rear|environment/i.test(label))) continue;
    const torch = capabilities?.torch;
    rear.push({ device, label, capabilities, autofocus: capabilities?.focusMode?.includes("continuous"),
      light: torch === true || torch?.includes?.(true) });
  }
  return rear;
}

export function findPreferredMainCamera(devices = [], activeId) {
  const rear = documentCameras(devices);
  // Some Android browsers expose only numbered rear cameras. Prefer a lens
  // with autofocus or a light. On a tie, keep the browser's working lens.
  let preferred, bestScore = -1;
  for (const item of rear) {
    const score = cameraScore(item.label, item.capabilities);
    if (score > bestScore || (score === bestScore && item.device.deviceId === activeId)) {
      preferred = item; bestScore = score;
    }
  }
  return preferred?.device || null;
}

// Lens discovery is optional. Some browsers defer it until the tab regains focus.
async function listCameraDevices(mediaDevices) {
  if (!mediaDevices?.enumerateDevices) return [];
  let timer;
  try {
    return await Promise.race([
      mediaDevices.enumerateDevices(),
      new Promise(resolve => { timer = setTimeout(() => resolve([]), 800); }),
    ]);
  } catch { return []; }
  finally { clearTimeout(timer); }
}

// Device listings on Android may contain only numbered rear cameras, with
// lighting available exclusively on the live track. Test each candidate once.
export async function alternateLightCameras(track, mediaDevices = navigator.mediaDevices) {
  const devices = await listCameraDevices(mediaDevices);
  let activeId;
  try { activeId = track.getSettings?.().deviceId; } catch { /* Match an unambiguous label instead. */ }
  if (!activeId) {
    const matches = devices.filter(device => device.kind === "videoinput" && track.label && device.label === track.label);
    if (matches.length === 1) activeId = matches[0].deviceId;
  }
  if (!activeId) return { activeId, alternatives: [] };
  const candidates = documentCameras(devices).filter(item => item.device.deviceId !== activeId);
  candidates.sort((a, b) => Number(Boolean(b.light)) - Number(Boolean(a.light)) ||
    Number(Boolean(b.autofocus)) - Number(Boolean(a.autofocus)));
  return { activeId, alternatives: [...new Set(candidates.map(item => item.device.deviceId))] };
}

export function requestCameraById(deviceId, mediaDevices = navigator.mediaDevices) {
  return mediaDevices.getUserMedia({ video: { ...QR_CAMERA_CONSTRAINTS.video, deviceId: { exact: deviceId } } });
}

export async function getPreferredCameraStream(mediaDevices = navigator.mediaDevices, signal) {
  let stream;
  function release() {
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
  }

  async function inspectAlternatives(devices) {
    const rear = documentCameras(devices);
    const activeId = cameraId(stream);
    const current = rear.find(item => item.device.deviceId === activeId);
    if (!current) return;
    let bestId = activeId, bestScore = cameraScore(current.label, current.capabilities);
    let liveId = activeId;
    const deadline = performance.now() + 4000;
    if (rear.length > 1 && bestScore < 4) {
      const live = await inspectCameraCapabilities(stream, signal);
      bestScore = cameraScore(current.label, { ...current.capabilities, ...live });
      // Keep the current camera on a tie. Exclude named front, ultrawide,
      // telephoto, macro and depth cameras before opening any candidates.
      const candidates = rear.filter(item => item.device.deviceId !== activeId)
        .sort((a, b) => cameraScore(b.label, b.capabilities) - cameraScore(a.label, a.capabilities)).slice(0, 2);
      for (const candidate of candidates) {
        const remaining = deadline - performance.now();
        if (bestScore >= 4 || remaining <= 0) break;
        release(); liveId = null;
        try {
          stream = await requestInspectionStream(() => requestCameraById(candidate.device.deviceId, mediaDevices),
            signal, Math.min(1500, remaining));
          signal?.throwIfAborted();
          liveId = cameraId(stream) || candidate.device.deviceId;
          const actual = rear.find(item => item.device.deviceId === liveId);
          if (!actual) continue;
          const capabilities = await inspectCameraCapabilities(stream, signal, Math.min(500, deadline - performance.now()));
          const score = cameraScore(actual.label, { ...actual.capabilities, ...capabilities });
          if (score > bestScore) { bestScore = score; bestId = liveId; }
        } catch (error) {
          signal?.throwIfAborted();
          if (permissionDenied(error)) throw error;
          // Stop inspecting on a slow or unavailable lens and restore the
          // best camera already seen, instead of extending startup further.
          break;
        }
      }
      if (liveId !== bestId) {
        release();
        try {
          stream = await requestInspectionStream(() => requestCameraById(bestId, mediaDevices), signal);
        } catch (error) {
          signal?.throwIfAborted();
          if (permissionDenied(error)) throw error;
          stream = await requestInspectionStream(() => mediaDevices.getUserMedia(QR_CAMERA_CONSTRAINTS), signal);
        }
      }
    }
    signal?.throwIfAborted();
    if (bestScore >= 2 && cameraId(stream) === bestId) inspectedCameras.set(mediaDevices, bestId);
  }

  signal?.addEventListener("abort", release, { once: true });
  try {
    signal?.throwIfAborted();
    const remembered = preferredCameraId() || inspectedCameras.get(mediaDevices);
    if (remembered) {
      try {
        // Open the known working lens directly, without briefly opening the
        // browser's default lens or enabling a light to discover it again.
        stream = await requestCameraById(remembered, mediaDevices);
        signal?.throwIfAborted();
        return stream;
      } catch (error) {
        signal?.throwIfAborted();
        if (permissionDenied(error)) throw error;
        forgetPreferredCamera(remembered);
        inspectedCameras.delete(mediaDevices);
      }
    }
    stream = await mediaDevices.getUserMedia(QR_CAMERA_CONSTRAINTS);
    signal?.throwIfAborted();
    const [track] = stream.getVideoTracks?.() || [];
    const initialId = cameraId(stream);
    const devices = await listCameraDevices(mediaDevices);
    const preferred = findPreferredMainCamera(devices, initialId);
    signal?.throwIfAborted();
    if (preferred?.deviceId && preferred.deviceId !== initialId &&
        !(!initialId && preferred.label && track?.label === preferred.label)) {
      // A phone may only open one rear lens at a time. Reacquire the original
      // camera if the advertised main lens cannot be opened.
      release();
      try {
        stream = await requestCameraById(preferred.deviceId, mediaDevices);
      } catch (error) {
        signal?.throwIfAborted();
        if (permissionDenied(error)) throw error;
        const fallback = initialId ? { video: { ...QR_CAMERA_CONSTRAINTS.video, deviceId: { ideal: initialId } } }
          : QR_CAMERA_CONSTRAINTS;
        stream = await mediaDevices.getUserMedia(fallback);
      }
    }
    signal?.throwIfAborted();
    await inspectAlternatives(devices);
    return stream;
  } catch (error) {
    release();
    throw error;
  } finally { signal?.removeEventListener("abort", release); }
}

export function cameraQualityPreferences(capabilities = {}, track) {
  const advanced = [];
  for (const name of ["focusMode", "exposureMode", "whiteBalanceMode"]) {
    if (capabilities[name]?.includes?.("continuous")) advanced.push({ [name]: "continuous" });
  }
  const zoom = cameraZoomRange(track, capabilities.zoom);
  if (zoom) advanced.push({ zoom: zoom.preferred });
  return advanced;
}

export async function applyCameraQualityControls(stream) {
  const [track] = stream?.getVideoTracks?.() || [];
  if (!track || typeof track.applyConstraints !== "function") return;
  const advanced = cameraQualityPreferences(track.getCapabilities?.(), track);
  if (advanced.length) {
    try { await track.applyConstraints({ advanced }); }
    catch { /* Keep the working rear camera if advertised controls are rejected. */ }
  }
}

export const applyContinuousCameraFocus = applyCameraQualityControls;
