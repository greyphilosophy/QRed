// A preview torch belongs to the live track. A still-photo flash belongs to
// ImageCapture. Keep the user's selection with the track that will take it.
import { cameraQualityPreferences } from "./cameraControls.js";

const lights = new WeakMap();
const flashHelp = "For flash, take a photo in your phone’s Camera app, then select Choose photo.";

async function waitForLight(request) {
  let timer;
  try {
    await Promise.race([request, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DOMException("Camera light did not respond.", "TimeoutError")), 750);
    })]);
  } finally { clearTimeout(timer); }
}

export function attachCameraLight(button, track, { video, progress } = {}) {
  if (!button || !track) return;
  const hint = button.ownerDocument.getElementById(button.getAttribute("aria-describedby"));
  const state = { mode: "off", pending: null };
  let capabilities, torch, flash = false, detached = false, torchFailed = false;
  const reportedTorch = () => {
    try { return track.getSettings?.().torch; } catch { return undefined; }
  };
  function refreshTorch() {
    const previous = torch;
    try { capabilities = track.getCapabilities?.(); } catch { capabilities = undefined; }
    const modes = capabilities?.torch;
    const actual = reportedTorch();
    // Missing capabilities can mean the driver is still opening. A settings
    // readback can be available even when capabilities omit the feature.
    if (typeof track.applyConstraints !== "function") torch = false;
    else if (typeof modes === "boolean") torch = modes;
    else if (modes?.length) torch = modes.includes(true);
    else torch = typeof actual === "boolean" ? true : undefined;
    if (torch === true && previous !== true) torchFailed = false;
    if (actual === true) state.mode = "torch";
  }
  function render() {
    if (detached) return;
    const on = state.mode !== "off";
    const unavailable = !on && !flash && (torchFailed || torch === false);
    let label = "Try flashlight";
    if (unavailable) label = "Flashlight unavailable";
    else if (state.mode === "flash" || (!on && prefersPhotoFlash())) label = `Photo flash ${on ? "on" : "off"}`;
    else if (on || torch === true) label = `Flashlight ${on ? "on" : "off"}`;
    button.hidden = false;
    button.disabled = Boolean(state.pending || progress?.getSnapshot());
    button.setAttribute("aria-pressed", String(on));
    if (button.textContent !== label) button.textContent = label;
    const message = unavailable && torchFailed ? flashHelp : "";
    if (hint && hint.textContent !== message) hint.textContent = message;
  }
  async function discoverFlash() {
    if (typeof globalThis.ImageCapture !== "function" || flash) return;
    try {
      const caps = await new ImageCapture(track).getPhotoCapabilities?.();
      if (detached) return;
      flash ||= Boolean(caps?.fillLightMode?.includes("flash"));
      refreshTorch();
      render();
    } catch { /* The track may only support a preview torch. */ }
  }
  function onPlaying() {
    if (detached) return;
    refreshTorch();
    render();
    void discoverFlash();
  }
  function prefersPhotoFlash() {
    return flash && (torch !== true || torchFailed);
  }
  async function setTorch(on) {
    const advanced = cameraQualityPreferences(capabilities);
    const advertised = capabilities?.torch === true || capabilities?.torch?.includes?.(true);
    // An unknown constraint can resolve without doing anything. For an
    // unadvertised torch, require confirmation from the lens before saying on.
    for (const request of [{ torch: { exact: on }, advanced }, { advanced: [{ torch: on }, ...advanced] }]) {
      try {
        await waitForLight(track.applyConstraints(request));
        if (detached) return false;
        const actual = reportedTorch();
        if (actual === on || (actual === undefined && advertised)) return true;
      } catch (error) {
        if (reportedTorch() === on) return true;
        if (detached || !["OverconstrainedError", "NotSupportedError", "TypeError"].includes(error.name)) break;
      }
    }
    return false;
  }
  async function change() {
    refreshTorch();
    if (state.mode === "flash") { state.mode = "off"; return; }
    const on = state.mode !== "torch";
    if (!on || (torch !== false && !prefersPhotoFlash())) {
      if (await setTorch(on)) { state.mode = on ? "torch" : "off"; torchFailed = false; return; }
      if (detached || !on) return; // Keep the off switch if the light is still on.
    }
    if (!flash) {
      // A slow shutter capability query must not hold up an ordinary capture.
      try { await waitForLight(discoverFlash()); } catch { /* A later report can still enable photo flash. */ }
    }
    if (detached) return;
    torchFailed = true;
    if (flash) state.mode = "flash";
  }
  function toggle() {
    if (state.pending || detached || progress?.getSnapshot()) return;
    state.pending = change().finally(() => { state.pending = null; render(); });
    render();
  }

  lights.set(track, state);
  button.addEventListener("click", toggle);
  video?.addEventListener?.("playing", onPlaying, { once: true });
  const unsubscribe = progress?.subscribe(render);
  onPlaying();
  return () => {
    detached = true;
    lights.delete(track);
    unsubscribe?.();
    video?.removeEventListener?.("playing", onPlaying);
    button.removeEventListener("click", toggle);
    button.hidden = true;
    button.disabled = false;
    button.setAttribute("aria-pressed", "false");
    if (hint) hint.textContent = "";
  };
}

export async function stillPhotoLighting(track) {
  const state = lights.get(track);
  if (state?.pending) await state.pending;
  if (state?.mode === "torch") return {}; // The preview light is already on.
  return { fillLightMode: state?.mode === "flash" ? "flash" : "off" };
}
