import { scanStageDiagnostic, scanStageLabel } from "./photoScanDiagnostics.js";

const PHASES = Object.freeze({
  opening: "Opening photo on this device…",
  capturing: "Hold steady — taking photo…",
  captured: "Reading photo…",
  decoding: "Reading photo…",
});

export const CAMERA_CAPTURED_NOTICE = "Photo captured. You can move your phone.";

// UI-only clock: never estimates completion or changes the decoder's budget.
// Each handle belongs to one capture so late events cannot revive a cancelled
// scan or overwrite the next photo. No document data is retained here.
export function createPhotoScanProgress() {
  let snapshot = null, generation = 0, timer;
  const listeners = new Set();
  const publish = value => { snapshot = value; listeners.forEach(listener => listener()); };
  const clearTimer = () => { clearInterval(timer); timer = undefined; };
  const clear = () => {
    generation++;
    clearTimer();
    if (snapshot) publish(null);
  };
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    clear,
    begin(initialPhase = "decoding") {
      clearTimer();
      const request = ++generation, started = performance.now();
      let phase = Object.hasOwn(PHASES, initialPhase) ? initialPhase : "decoding";
      let stepStarted = started, label = PHASES[phase];
      const active = () => generation === request;
      const tick = () => {
        if (!active()) return;
        const now = performance.now();
        publish({ phase, label,
          elapsedMs: Math.max(0, now - started), stepElapsedMs: Math.max(0, now - stepStarted) });
      };
      const step = (next, nextPhase = phase) => {
        if (!active() || !next || (next === label && nextPhase === phase)) return;
        phase = nextPhase;
        label = next;
        stepStarted = performance.now();
        tick();
      };
      tick();
      timer = setInterval(tick, 250);
      return {
        photoReady() {
          if (phase === "capturing") step(PHASES.captured, "captured");
          else if (phase === "opening") step(PHASES.decoding, "decoding");
        },
        stage(value) {
          const diagnostic = scanStageDiagnostic(value);
          const name = diagnostic && scanStageLabel(diagnostic);
          step(name ? name[0].toUpperCase() + name.slice(1) + "…" : null);
        },
        stop() { if (active()) clear(); },
      };
    },
  };
}

export function photoScanTiming(snapshot) {
  return `Elapsed ${(snapshot.elapsedMs / 1000).toFixed(1)} s · this step ${(snapshot.stepElapsedMs / 1000).toFixed(1)} s`;
}
