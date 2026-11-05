// Session-only timing checkpoints. Never include pixels, payloads, exception
// text, camera identifiers or arbitrary decoder strings in these diagnostics.
const STAGE_LABELS = Object.freeze({
  "rectified-fast": "finding the page grid",
  "watermark-preview": "checking the watermark",
  "ordinary-qr": "reading conventional QR codes",
  footer: "checking footer seals",
  "rectified-wide": "refining the page grid",
  "page-aligned": "checking page layouts",
  "general-qr": "trying other QR reads",
});

export function scanStageDiagnostic(value) {
  if (!value || typeof value.stage !== "string" || !Object.hasOwn(STAGE_LABELS, value.stage)
    || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 600_000) return null;
  return { stage: value.stage, elapsedMs: Math.round(value.elapsedMs) };
}

export function scanStageLabel(value) {
  const diagnostic = scanStageDiagnostic(value);
  return diagnostic ? STAGE_LABELS[diagnostic.stage] : null;
}

export function scanStageFeedback(value) {
  const diagnostic = scanStageDiagnostic(value);
  if (!diagnostic) return "";
  return ` Last reported step: ${STAGE_LABELS[diagnostic.stage]} (${(diagnostic.elapsedMs / 1000).toFixed(1)} s into decoding).`;
}
