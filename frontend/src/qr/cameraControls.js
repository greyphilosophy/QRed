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
    rear.push({ device, label, autofocus: capabilities?.focusMode?.includes("continuous"),
      light: torch === true || torch?.includes?.(true) });
  }
  return rear;
}

export function findPreferredMainCamera(devices = [], activeId) {
  const rear = documentCameras(devices);
  // Some Android browsers expose only numbered rear cameras. Prefer a lens
  // with autofocus or a light. On a tie, keep the browser's working lens.
  const preferred = rear.find(item => /main|primary|\b1(?:\.0+)?x\b/i.test(item.label))
    || rear.find(item => /wide/i.test(item.label)) || rear.find(item => item.autofocus && item.light)
    || rear.find(item => item.autofocus) || rear.find(item => item.light)
    || rear.find(item => item.device.deviceId === activeId) || rear[0];
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
  signal?.addEventListener("abort", release, { once: true });
  try {
    signal?.throwIfAborted();
    stream = await mediaDevices.getUserMedia(QR_CAMERA_CONSTRAINTS);
    signal?.throwIfAborted();
    const [track] = stream.getVideoTracks?.() || [];
    const initialId = track?.getSettings?.().deviceId;
    const preferred = findPreferredMainCamera(await listCameraDevices(mediaDevices), initialId);
    signal?.throwIfAborted();
    if (!preferred?.deviceId || preferred.deviceId === initialId ||
        (!initialId && preferred.label && track?.label === preferred.label)) return stream;

    // A phone may only open one rear lens at a time. Reacquire the original
    // camera if the advertised main lens cannot be opened.
    release();
    try {
      stream = await requestCameraById(preferred.deviceId, mediaDevices);
    } catch (error) {
      signal?.throwIfAborted();
      if (error.name === "NotAllowedError" || error.name === "SecurityError") throw error;
      const fallback = initialId ? { video: { ...QR_CAMERA_CONSTRAINTS.video, deviceId: { ideal: initialId } } }
        : QR_CAMERA_CONSTRAINTS;
      stream = await mediaDevices.getUserMedia(fallback);
    }
    signal?.throwIfAborted();
    return stream;
  } catch (error) {
    release();
    throw error;
  } finally { signal?.removeEventListener("abort", release); }
}

export function cameraQualityPreferences(capabilities = {}) {
  const advanced = [];
  for (const name of ["focusMode", "exposureMode", "whiteBalanceMode"]) {
    if (capabilities[name]?.includes?.("continuous")) advanced.push({ [name]: "continuous" });
  }
  if (Number.isFinite(capabilities.zoom?.max)) {
    const min = Number.isFinite(capabilities.zoom.min) ? capabilities.zoom.min : 1;
    // Explicitly reset a retained zoom setting, even when 1x is the minimum.
    advanced.push({ zoom: Math.max(min, Math.min(1, capabilities.zoom.max)) });
  }
  return advanced;
}

export async function applyCameraQualityControls(stream) {
  const [track] = stream?.getVideoTracks?.() || [];
  if (!track || typeof track.applyConstraints !== "function") return;
  const advanced = cameraQualityPreferences(track.getCapabilities?.());
  if (advanced.length) {
    try { await track.applyConstraints({ advanced }); }
    catch { /* Keep the working rear camera if advertised controls are rejected. */ }
  }
}

export const applyContinuousCameraFocus = applyCameraQualityControls;
