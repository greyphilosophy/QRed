// Keep a camera confirmed by the user's light/framing choice only for this
// page visit. A reload chooses a rear camera from its current capabilities.
let selectedId = null;

// Remove the preference saved by older versions without reading or using it.
try { globalThis.localStorage?.removeItem("qred.document-camera.v1"); }
catch { /* Camera access still works when browser storage is blocked. */ }

function validId(id) {
  return typeof id === "string" && id.trim().length > 0 && id.length <= 512;
}

export function preferredCameraId() {
  return selectedId;
}

export function rememberPreferredCamera(track) {
  let settings;
  try { settings = track?.getSettings?.(); } catch { return null; }
  if (settings?.facingMode === "user" || !validId(settings?.deviceId)) return null;
  selectedId = settings.deviceId;
  return selectedId;
}

export function forgetPreferredCamera(id) {
  // A late failure must not erase a newer successful choice.
  if (preferredCameraId() !== id) return;
  selectedId = null;
}
