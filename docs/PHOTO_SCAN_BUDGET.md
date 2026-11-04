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
