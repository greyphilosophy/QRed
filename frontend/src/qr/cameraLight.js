// A preview torch belongs to the live track. A still-photo flash belongs to
// ImageCapture. Keep the user's selection with the track that will take it.
import { cameraQualityPreferences } from "./cameraControls.js";
import { cameraZoomRange, rememberCameraZoom } from "./cameraFraming.js";

const lights = new WeakMap();
const flashHelp = "Use the flash in your phone’s Camera app. QRed will read the photo when you return.";

async function waitForLight(request) {
  let timer;
  try {
    await Promise.race([request, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DOMException("Camera light did not respond.", "TimeoutError")), 750);
    })]);
  } finally { clearTimeout(timer); }
}

export function attachCameraLight(button, track, { video, progress, enableOnPlayback = false, preferPhoneCamera = false,
  framingSelect, onLightUnavailable, onTorchStuck, onProbeFinished, onPhoneCamera } = {}) {
  if (!button || !track) return;
  const hint = button.ownerDocument.getElementById(button.getAttribute("aria-describedby"));
  const state = { mode: "off", pending: null, paused: false, resumeTorch };
  let capabilities, torch, flash = false, detached = false, torchFailed = false;
  let showHelp = preferPhoneCamera, enableWhenReady = enableOnPlayback;
  let framing, lastZoom, zoomFailed = false;
  const reportedTorch = () => {
    try { return track.getSettings?.().torch; } catch { return undefined; }
  };
  function processingPhoto() {
    const snapshot = progress?.getSnapshot();
    return Boolean(snapshot && snapshot.phase !== "capturing");
  }
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
    if (torch === true && previous !== true && !preferPhoneCamera) { torchFailed = false; showHelp = false; }
    if (actual === true) state.mode = "torch";
  }
  function refreshFraming() {
    if (!framingSelect) return;
    framing = !zoomFailed && typeof track.applyConstraints === "function" ? cameraZoomRange(track, capabilities?.zoom) : null;
    let actual;
    try { actual = track.getSettings?.().zoom; } catch { /* Optional readback. */ }
    if (Number.isFinite(actual)) lastZoom = actual;
    const choices = framing?.choices.length > 1 ? framing.choices : [];
    const selected = choices.find(choice => Math.abs(choice.value - lastZoom) < 0.001);
    const options = choices.map(({ value, label }) => [String(value), label]);
    // A neutral prompt also covers a setting between our presets.
    if (!selected) options.unshift(["", "Framing"]);
    if (onPhoneCamera) options.push(["phone", "Phone camera…"]);
    if (options.length !== framingSelect.length || options.some(([value, label], index) =>
      framingSelect.options[index]?.value !== value || framingSelect.options[index]?.text !== label)) {
      framingSelect.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
    }
    if (framingSelect.options[0]?.value === "") framingSelect.options[0].disabled = true;
    framingSelect.value = selected ? String(selected.value) : "";
    framingSelect.hidden = options.length < 2;
  }
  async function changeFraming(zoom) {
    const advanced = cameraQualityPreferences(capabilities, track).filter(entry => !("zoom" in entry));
    if (state.mode === "torch" || reportedTorch() === true) advanced.unshift({ torch: true });
    try {
      await waitForLight(track.applyConstraints({ zoom: { exact: zoom }, advanced }));
      if (detached) return;
      const actual = track.getSettings?.().zoom;
      if (Number.isFinite(actual) && Math.abs(actual - zoom) >= 0.001) { zoomFailed = true; return; }
      lastZoom = zoom;
      rememberCameraZoom(track, zoom);
    } catch { if (!detached) zoomFailed = true; }
  }
  function render() {
    if (detached) return;
    const on = state.mode !== "off" && !state.paused;
    let label = "Try flashlight";
    if (state.paused) label = "Flashlight paused";
    else if (enableWhenReady || (state.pending && !on)) label = "Checking light…";
    else if (showHelp && !on) label = onPhoneCamera ? "Use phone camera" : "Flashlight unavailable";
    else if (state.mode === "flash" || (!on && prefersPhotoFlash())) label = `Photo flash ${on ? "on" : "off"}`;
    else if (on || torch === true) label = `Flashlight ${on ? "on" : "off"}`;
    else if ((torch === false && !onLightUnavailable) || torchFailed) label = "Flashlight unavailable";
    button.hidden = false;
    button.disabled = Boolean(enableWhenReady || state.pending || state.paused || progress?.getSnapshot());
    if (framingSelect) framingSelect.disabled = button.disabled;
    refreshFraming();
    if (label === "Use phone camera") button.removeAttribute("aria-pressed");
    else button.setAttribute("aria-pressed", String(on));
    if (button.textContent !== label) button.textContent = label;
    const message = zoomFailed && onPhoneCamera ? "For 1×, choose Phone camera from Framing." : showHelp && !on ? flashHelp : "";
    if (hint && hint.textContent !== message) hint.textContent = message;
  }
  async function discoverFlash() {
    if (typeof globalThis.ImageCapture !== "function" || flash) return;
    try {
      const caps = await new ImageCapture(track).getPhotoCapabilities?.();
      if (detached) return;
      if (caps?.fillLightMode?.includes("flash")) { flash = true; showHelp = false; }
      refreshTorch();
      render();
    } catch { /* The track may only support a preview torch. */ }
  }
  async function checkPhotoFlash() {
    // A slow shutter capability query must not hold up an ordinary capture.
    try { await waitForLight(discoverFlash()); } catch { /* A later report can still enable photo flash. */ }
  }
  function onPlaying() {
    if (detached) return;
    refreshTorch();
    onProgress();
    void discoverFlash();
    if (enableWhenReady && video?.readyState >= 2 && !processingPhoto()) {
      enableWhenReady = false;
      if (state.mode === "torch") { onProbeFinished?.(true); render(); }
      else startChange(change);
    }
  }
  function prefersPhotoFlash() {
    return flash && (torch !== true || torchFailed);
  }
  async function setTorch(on) {
    const advanced = cameraQualityPreferences(capabilities, track);
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
    if (on && torch !== true && !flash) await checkPhotoFlash();
    if (detached) return;
    if (!on || (torch !== false && !prefersPhotoFlash())) {
      if (await setTorch(on)) {
        if (detached) return;
        state.mode = on ? "torch" : "off"; torchFailed = false; showHelp = false;
        if (on) onProbeFinished?.(true);
        return;
      }
      if (detached || !on) return; // Keep the off switch if the light is still on.
    }
    if (!flash && torch === true) await checkPhotoFlash();
    if (detached) return;
    torchFailed = true;
    if (flash) { state.mode = "flash"; onProbeFinished?.(true); return; }
    const offerPhone = await onLightUnavailable?.(track);
    if (!detached && offerPhone !== false) showHelp = true;
    else if (!detached) { torchFailed = false; onProbeFinished?.(false); }
  }
  function startChange(operation) {
    state.pending = operation().finally(() => { state.pending = null; onProgress(); });
    render();
    return state.pending;
  }
  function onProgress() {
    // Once the shutter returns, processing uses the saved photo and the torch can pause.
    if (!detached && state.mode === "torch" && !state.pending && !state.paused && processingPhoto()) {
      state.paused = true;
      startChange(async () => {
        const switchedOff = await setTorch(false);
        if ((!switchedOff || reportedTorch() !== false) && !detached && processingPhoto()) onTorchStuck?.(track);
      });
    } else render();
  }
  function resumeTorch() {
    if ((!state.paused && !enableWhenReady) || detached || state.pending || processingPhoto() || track.readyState === "ended") return;
    if (enableWhenReady) { onPlaying(); return state.pending; }
    return startChange(async () => {
      const enabled = await setTorch(true);
      if (detached) return;
      state.paused = false;
      if (!enabled) state.mode = "off";
    });
  }
  function toggle() {
    if (state.pending || state.paused || detached || progress?.getSnapshot()) return;
    if (showHelp) {
      if (onPhoneCamera) onPhoneCamera();
      else { showHelp = false; render(); }
      return;
    }
    startChange(change);
  }
  function selectFraming() {
    if (state.pending || state.paused || detached || enableWhenReady || progress?.getSnapshot()) { render(); return; }
    const value = framingSelect.value;
    if (value === "phone") { refreshFraming(); onPhoneCamera?.(); return; }
    const zoom = framing?.choices?.find(choice => String(choice.value) === value)?.value;
    if (zoom === undefined) return;
    startChange(() => changeFraming(zoom));
  }

  lights.set(track, state);
  button.addEventListener("click", toggle);
  framingSelect?.addEventListener("change", selectFraming);
  video?.addEventListener?.("playing", onPlaying, { once: true });
  const unsubscribe = progress?.subscribe(onProgress);
  onPlaying();
  function detach() {
    detached = true;
    lights.delete(track);
    unsubscribe?.();
    video?.removeEventListener?.("playing", onPlaying);
    button.removeEventListener("click", toggle);
    framingSelect?.removeEventListener("change", selectFraming);
    if (framingSelect) { framingSelect.hidden = true; framingSelect.disabled = false; }
    button.hidden = true;
    button.disabled = false;
    button.setAttribute("aria-pressed", "false");
    if (hint) hint.textContent = "";
  }
  return { detach, resumeTorch, refresh: () => { if (!detached) { refreshTorch(); onProgress(); } } };
}

export function hasPausedTorch(track) {
  return lights.get(track)?.paused === true;
}

export async function stillPhotoLighting(track) {
  const state = lights.get(track);
  while (state?.pending) await state.pending;
  // A manual capture can beat the next preview frame after a cancelled read.
  await state?.resumeTorch();
  const current = lights.get(track);
  if (current?.mode === "torch" && !current.paused) return {};
  return { fillLightMode: current?.mode === "flash" ? "flash" : "off" };
}
