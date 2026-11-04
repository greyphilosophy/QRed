// Cooperative decoding and the UI worker watchdog share one photo budget.
export const PHOTO_SCAN_BUDGET_MS = 8000;

export function photoScanTimeoutAction(partial = null) {
  return {
    ...(partial || { status: "feedback" }),
    timedOut: true,
    message: "The photo scan reached its time limit. Use Capture now to try again, or choose a clearer photo. Include all four page corners and avoid glare.",
  };
}
