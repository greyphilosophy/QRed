import { CAMERA_CAPTURED_NOTICE, createPhotoScanProgress, photoScanTiming } from "./photoScanProgress.js";
import "./photoScanProgress.css";

export function mountPhotoScanProgress(element, captureNotice) {
  const progress = createPhotoScanProgress();
  element.classList.add("photo-scan-progress");
  const step = document.createElement("p"), timing = document.createElement("p"), bar = document.createElement("progress");
  step.className = "photo-scan-step";
  step.setAttribute("role", "status");
  step.setAttribute("aria-live", "polite");
  timing.className = "photo-scan-timing";
  // Keep the ticking clock out of the live region to avoid repeated speech.
  timing.setAttribute("role", "timer");
  timing.setAttribute("aria-live", "off");
  bar.setAttribute("aria-label", "Photo seal scan");
  element.replaceChildren(step, timing, bar);
  const render = () => {
    const snapshot = progress.getSnapshot();
    captureNotice?.toggleAttribute("data-hide-guide", Boolean(snapshot && snapshot.phase !== "capturing"));
    const message = snapshot?.phase === "captured" ? CAMERA_CAPTURED_NOTICE : "";
    if (captureNotice && captureNotice.textContent !== message) {
      captureNotice.textContent = message;
      if (message) captureNotice.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "instant" });
    }
    element.hidden = !snapshot;
    if (!snapshot) { step.textContent = timing.textContent = ""; return; }
    if (step.textContent !== snapshot.label) step.textContent = snapshot.label;
    timing.textContent = photoScanTiming(snapshot);
  };
  const unsubscribe = progress.subscribe(render);
  render();
  return { ...progress, dispose() { progress.clear(); unsubscribe(); element.replaceChildren(); element.hidden = true; } };
}
