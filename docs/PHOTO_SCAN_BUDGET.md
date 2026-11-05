# Photo scan time budget

A captured or selected photo has an eight-second seal-decoding budget. The
synchronous decoder checks its deadline between attempts. A separate watchdog in
the caller terminates the worker if an individual synchronous attempt (including
jsQR) overruns that budget. A timer inside the decoder worker would not interrupt
such work.

The watchdog starts when a selected/native still is submitted, including worker
startup. For a photo decoded in the persistent live worker, it starts on the
capture acknowledgement. Camera permission, focus/steady hold, native still
acquisition, OCR preparation, OCR, and signature verification are separate
operations. Browser timer scheduling can be delayed when the tab is suspended or
the main thread is blocked; this is not a physical-phone latency guarantee.

Recovered multipart chunks are checkpointed before starting additional footer or
page-alignment attempts. On timeout, the caller returns the latest delivered
checkpoint through the normal verification flow, or retake guidance if nothing
was recovered. These are decoded transport payloads, not authentication results:
all signature, completeness, and page checks still apply. Progress does not
extend the deadline.

Each request owns its own worker, deadline, and progress. Completion,
cancellation, transfer failure, and worker errors clear its timer and handlers.
Queued late results cannot replace the settled result. OCR pixel preparation is
not subject to the seal decoder's deadline.

Terminating the persistent live worker also loses its page-movement gate. After
a captured-photo timeout, automatic capture stays paused instead of repeatedly
capturing unchanged paper. The user can choose **Capture now** or reopen the
scanner. An explicit reset starts a fresh gate. Native-still handoff does not
start a timeout in the live worker; its separate photo request owns that budget.

## Validation

- Fake-clock worker tests cover exact deadline expiry, partial checkpoints,
  concurrent requests, cancellation, errors, late messages, live reset/stop,
  native-still handoff, and OCR-preparation isolation.
- Decoder/footer/alignment tests check that recovered chunks are reported before
  the next expensive attempt, without accepting navigation codes as payloads.
- Both camera interfaces and photo upload must show timeout guidance even when a
  partial chunk was recovered. The UI remains available for a manual retry.
- Actual CPU-bound termination can be checked in an isolated worker using a
  difficult local photo. Private photographs should never be committed or
  uploaded as test fixtures. Node worker timings are not browser/phone results.

This guard makes an unsuccessful scan stop sooner. It does not repair optical
recovery and must not be used as evidence that a previously unreadable seal now
reads successfully.

## Camera input and failure details

Native still acquisition retains its separate 1.8-second total deadline. Missing
or explicitly unsupported optional capability discovery can fall back to still
capture without resolution preferences. If advertised dimensions are rejected
with a settings-related error, capture retries once without those dimensions,
within the same deadline. Both attempts explicitly keep flash off. Permission,
security and camera-operation failures are not retried. Late results cannot
replace the frozen frame or update its diagnostic.

If seal reading fails, camera interfaces show whether the submitted pixels came
from a native camera photo or a video frame, their actual width and height, and a
fixed fallback reason when available. These details stay in that camera session;
no device labels/IDs, exception text, document content or pixels are logged,
stored or transmitted by the diagnostic. It reports the frozen decoder input,
not the size of the current on-screen video. This compatibility change does not
establish successful recovery of any previously unreadable physical page.
