import { scanStageDiagnostic, scanStageFeedback } from "./photoScanDiagnostics.js";

// Cooperative decoding and the UI worker watchdog share one photo budget.
export const PHOTO_SCAN_BUDGET_MS = 60_000;

export function photoScanTimeoutAction(partial = null, stage = null, workerUrl = "") {
  const scanDiagnostic = scanStageDiagnostic(stage);
  // Identify the actual bundled decoder in a timeout screenshot, including
  // offline sessions. Only its public content hash belongs in the feedback.
  const build = /\/photoScan\.worker-([\w-]{8,32})\.js(?:[?#]|$)/.exec(workerUrl)?.[1];
  return {
    ...(partial || { status: "feedback" }),
    ...(scanDiagnostic ? { scanDiagnostic } : {}),
    timedOut: true,
    message: "The photo scan reached its time limit. Use Capture now to try again, or choose a clearer photo. Include all four page corners and avoid glare."
      + scanStageFeedback(scanDiagnostic) + (build ? ` Scanner build ${build}.` : ""),
  };
}
