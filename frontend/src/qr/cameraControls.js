export const QR_CAMERA_CONSTRAINTS = {
  video: {
    facingMode: { ideal: "environment" },
    // Dense full-page seals need more detail than a 1080p preview. These are
    // preferences, so cameras with lower limits can still open normally.
    width: { ideal: 3840 },
    height: { ideal: 2880 },
  },
};

export function findPreferredMainCamera(devices = []) {
  const rear = devices.filter(device => device.kind === "videoinput"
    && /back|rear|environment/i.test(device.label || "")
    && !/front|ultra|telephoto|zoom|\b[2-9](?:\.\d+)?x\b|\b0\.\d+x\b/i.test(device.label || ""));
  return rear.find(device => /main|primary|\b1x\b/i.test(device.label))
    || rear.find(device => /wide/i.test(device.label)) || null;
}

// Lens discovery is optional. Some browsers defer it until the tab regains focus.
async function discoverMainCamera(mediaDevices) {
  if (!mediaDevices.enumerateDevices) return null;
  let timer;
  try {
    const devices = await Promise.race([
      mediaDevices.enumerateDevices(),
      new Promise(resolve => { timer = setTimeout(() => resolve([]), 800); }),
    ]);
    return findPreferredMainCamera(devices);
  } catch { return null; }
  finally { clearTimeout(timer); }
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
    const preferred = await discoverMainCamera(mediaDevices);
    signal?.throwIfAborted();
    const [track] = stream.getVideoTracks?.() || [];
    const initialId = track?.getSettings?.().deviceId;
    if (!preferred?.deviceId || preferred.deviceId === initialId || track?.label === preferred.label) return stream;

    // A phone may only open one rear lens at a time. Reacquire the original
    // camera if the advertised main lens cannot be opened.
    release();
    try {
      stream = await mediaDevices.getUserMedia({ video: {
        ...QR_CAMERA_CONSTRAINTS.video, deviceId: { exact: preferred.deviceId },
      } });
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

export async function applyCameraQualityControls(stream) {
  const [track] = stream?.getVideoTracks?.() || [];
  if (!track || typeof track.applyConstraints !== "function") return;
  const capabilities = typeof track.getCapabilities === "function" ? track.getCapabilities() : {};
  const advanced = [];
  for (const name of ["focusMode", "exposureMode", "whiteBalanceMode"]) {
    if (capabilities[name]?.includes?.("continuous")) advanced.push({ [name]: "continuous" });
  }
  if (Number.isFinite(capabilities.zoom?.max)) {
    const min = Number.isFinite(capabilities.zoom.min) ? capabilities.zoom.min : 1;
    // Explicitly reset a retained zoom setting, even when 1x is the minimum.
    advanced.push({ zoom: Math.max(min, Math.min(1, capabilities.zoom.max)) });
  }
  if (advanced.length) {
    try { await track.applyConstraints({ advanced }); }
    catch { /* Keep the working rear camera if advertised controls are rejected. */ }
  }
}

export const applyContinuousCameraFocus = applyCameraQualityControls;
