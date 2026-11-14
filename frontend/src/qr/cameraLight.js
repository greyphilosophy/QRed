// A preview torch belongs to the live track. A still-photo flash belongs to
// ImageCapture. Keep the user's selection with the track that will take it.
import { cameraQualityPreferences } from "./cameraControls.js";
const lights = new WeakMap();
const torchSupported = modes => modes === true || modes?.includes?.(true);

export function attachCameraLight(button, track) {
  if (!button || !track) return;
  let capabilities;
  try { capabilities = track.getCapabilities?.(); } catch { /* Optional on some cameras. */ }
  let torch = Boolean(track.applyConstraints && torchSupported(capabilities?.torch));
  let flash = false, detached = false, busy = false, failed = false;
  let discoverFlash;
  const state = { mode: "off", pending: null };
  const reportedTorch = () => {
    try { return track.getSettings?.().torch; } catch { return undefined; }
  };
  if (torch && reportedTorch() === true) state.mode = "torch";
  lights.set(track, state);

  function render() {
    if (detached) return;
    button.hidden = !torch && !flash && !failed;
    button.disabled = busy || (!torch && !flash);
    const on = state.mode !== "off";
    button.setAttribute("aria-pressed", String(on));
    const name = torch ? "Flashlight" : "Photo flash";
    button.textContent = failed ? "Flashlight unavailable" : `${name} ${on ? "on" : "off"}`;
  }
  // An advanced constraint may resolve even when the driver skips it. Use
  // the required form first, and check the actual setting where available.
  async function setTorch(on) {
    const advanced = cameraQualityPreferences(capabilities);
    for (const request of [{ torch: { exact: on }, advanced }, { advanced: [{ torch: on }, ...advanced] }]) {
      try {
        await track.applyConstraints(request);
        if (detached) return false;
        const actual = reportedTorch();
        if (actual === undefined || actual === on) return true;
      } catch (error) {
        if (detached || !["OverconstrainedError", "NotSupportedError", "TypeError"].includes(error.name)) break;
      }
    }
    return false;
  }
  async function change() {
    const on = state.mode === "off";
    if (torch) {
      if (await setTorch(on)) { state.mode = on ? "torch" : "off"; return; }
      if (detached) return;
      if (!on) return; // Keep the off switch available if the light is still on.
      torch = false;
    }
    if (!flash && discoverFlash) await discoverFlash;
    if (detached) return;
    if (flash) state.mode = on ? "flash" : "off";
    else failed = true;
  }
  function toggle() {
    if (busy || detached) return;
    busy = true; render();
    state.pending = change().finally(() => { state.pending = null; busy = false; render(); });
  }
  button.addEventListener("click", toggle);
  render();
  // Discover shutter-only lighting without holding up the preview or a torch.
  if (typeof globalThis.ImageCapture === "function") {
    const discover = async () => {
      try {
        const caps = await new ImageCapture(track).getPhotoCapabilities?.();
        if (detached) return;
        flash = Boolean(caps?.fillLightMode?.includes("flash"));
        if (flash && failed) failed = false;
        render();
      } catch { /* The track may only support a preview torch. */ }
    };
    discoverFlash = discover();
  }
  return () => {
    detached = true;
    lights.delete(track);
    button.removeEventListener("click", toggle);
    button.hidden = true;
    button.disabled = false;
    button.setAttribute("aria-pressed", "false");
  };
}

export async function stillPhotoLighting(track) {
  const state = lights.get(track);
  if (state?.pending) await state.pending;
  if (state?.mode === "torch") return {}; // The preview light is already on.
  return { fillLightMode: state?.mode === "flash" ? "flash" : "off" };
}
