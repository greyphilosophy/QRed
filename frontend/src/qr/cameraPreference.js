// Only a camera confirmed by the user's light/framing choice is remembered.
// This opaque, origin-scoped ID stays in this browser; it is not scan metadata.
const STORAGE_KEY = "qred.document-camera.v1";
let selectedId;

function validId(id) {
  return typeof id === "string" && id.trim().length > 0 && id.length <= 512;
}

export function preferredCameraId() {
  if (selectedId === undefined) {
    selectedId = null;
    try {
      const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (validId(stored)) selectedId = stored;
    } catch { /* Camera access still works when browser storage is blocked. */ }
  }
  return selectedId;
}

export function rememberPreferredCamera(track) {
  let settings;
  try { settings = track?.getSettings?.(); } catch { return null; }
  if (settings?.facingMode === "user" || !validId(settings?.deviceId)) return null;
  selectedId = settings.deviceId;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, selectedId); }
  catch { /* Keep the preference for this page when persistent storage fails. */ }
  return selectedId;
}

export function forgetPreferredCamera(id) {
  // A late failure must not erase a newer successful choice.
  if (preferredCameraId() !== id) return;
  selectedId = null;
  try { globalThis.localStorage?.removeItem(STORAGE_KEY); }
  catch { /* The in-memory preference is still cleared. */ }
}
