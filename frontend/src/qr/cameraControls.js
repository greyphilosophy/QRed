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

export async function getPreferredCameraStream(mediaDevices = navigator.mediaDevices) {
  const stream = await mediaDevices.getUserMedia(QR_CAMERA_CONSTRAINTS);
  if (typeof mediaDevices.enumerateDevices !== "function") return stream;
  let preferred;
  try { preferred = findPreferredMainCamera(await mediaDevices.enumerateDevices()); }
  catch { return stream; }
  const [track] = stream.getVideoTracks?.() || [];
  if (!preferred?.deviceId || track?.getSettings?.().deviceId === preferred.deviceId
    || track?.label === preferred.label) return stream;
  try {
    const main = await mediaDevices.getUserMedia({ video: {
      ...QR_CAMERA_CONSTRAINTS.video, deviceId: { exact: preferred.deviceId },
    } });
    stream.getTracks().forEach(current => current.stop());
    return main;
  } catch { return stream; }
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
