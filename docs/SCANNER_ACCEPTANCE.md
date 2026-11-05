# Scanner acceptance: test the camera workflow

A photo decoding successfully does not prove that the scanner can acquire that
photo. Report these three results separately: **saved-photo recovery**, **browser
camera workflow**, and **physical phone capture**. Never close a scanner failure
with only the first result.

## Required automated checks

Run the production build in a real browser. Mock only unavailable hardware,
never the framing decision, recovered seal, authenticated result, or OCR text.

- `tests/test_scanner_workflow.py`: stamp a synthetic invoice through the actual
  PDF UI, rasterize the entire stamped page at 240 DPI, and put that whole page
  into the camera workflow. Feed clipped, defocused, and moving previews, then a
  steady page. No shutter click or file input is allowed. Check no early capture,
  a fresh 600 ms steady hold before requesting the photo,
  exactly one full-detail native photo, real signature authentication, an exact
  matched-word list with no document differences or OCR uncertainty, stopped
  tracks, and Finish & clear. The separate caution for QRed's printed markings,
  including its navigation caption, must stay visible; it is not a document
  mismatch. Both `/` and `/verify.htm` run
  a clear case and a fixed 97%-print-scale, dimmed, JPEG-compressed case.
- `tests/test_auto_capture.py`: keep the existing changed-text, mismatched-page
  retake, capture acknowledgement, separate low-resolution preview/native still,
  unavailable/rejected/undersized native-photo, and explicit recovery checks.
- `tests/test_scanner_usability.py`: keep main-camera selection, orientation,
  guide/control geometry, worker backpressure, cancellation, same-camera resume,
  and offline checks. Component tests also guard delayed camera startup and
  picker cancellation so stale work cannot resume or replace a closed session.
- `tests/test_capture_performance.py`: retain the short clear-page latency gate.
  The production-PDF workflow separately logs time to authenticated page, OCR
  time, and longest UI task. Its generous CI limits detect gross regressions;
  they are not mobile performance claims.
- Decoder acceptance and unit tests remain necessary for perspective, colored
  text, illumination, multipart recovery, corruption, deadlines, and signature
  failures. They complement the camera gate; they cannot replace it.

Example local run after installing the repository's Python/browser dependencies:

```sh
cd frontend && npm ci && npm run build
npm exec vite preview -- --host 127.0.0.1 --port 3000
# In another shell, from the repository root:
QRED_BASE_URL=http://localhost:3000 pytest -v --durations=10 \
  tests/test_scanner_workflow.py tests/test_auto_capture.py \
  tests/test_capture_performance.py tests/test_scanner_usability.py
```

The existing CI catch-all E2E shard includes every new test file automatically.
An assertion failure must block acceptance, not be marked expected-to-fail,
removed from the shard, or resolved by weakening the scenario until it passes.

## Physical acceptance, separately reported

Canvas streams and a simulated `ImageCapture` cannot validate camera permission,
real autofocus/exposure, native-photo API support, sensor detail, motion blur,
thermal throttling, printer ink, or real phone latency. Saved JPEG replay cannot
validate any earlier capture stage either. Keep the print reliability gate in
`WATERMARK_READABILITY_REQUIREMENTS.md` open until its physical criteria pass.

For the exact candidate build on each supported phone/browser:

1. Open QRed normally, start Check document, grant the requested camera access,
   and frame a complete printed page. Record the initial preview condition and
   whether guidance actually helps the user obtain a photo. Do not substitute a
   gallery upload and count it as a successful automatic capture.
2. Try normal lighting, dim/uneven lighting, mild tilt, and hand movement. Include
   a dense text/table page and the actual production layout (single watermark,
   multipart watermark, or footer). Count every initial attempt, including
   waiting indefinitely or timing out before a photo is obtained.
3. Confirm the capture acknowledgement occurs after a real photo is acquired.
   Record its reported source and pixel dimensions, then separately record seal
   authentication and printed-text result. Alter a harmless word/amount on a
   synthetic print and confirm a difference is surfaced, not called a match.
4. Cancel a capture, dismiss the photo picker, retake, rotate, and Finish & clear.
   Confirm usable recovery without reloading, no stale result, no repeat capture
   of stationary paper, and no camera indicator left on after ending the check.
5. Repeat with offline resources prepared. Test a browser without native-still
   support: it must explain the explicit photo-choice fallback, never quietly
   decode video pixels. Record it as **fallback**, not hands-free success.

Use a concise record per attempt: commit/build, route, phone/browser, paper/layout,
printer resolution/scaling, lighting/motion, time to usable preview, guidance,
time to photo/source/dimensions, time to authenticated seal, time to text verdict,
result, and recovery behavior. Repeating only the best frame hides acquisition
failures. Report complete successful workflows / all attempts, not successful
decodes / selected photos. Keep any real private documents and photographs local
unless their publication was explicitly authorized.

## Failure triage and release language

Find the first failed stage: camera start, framing/focus hold, native acquisition,
seal decoding, authentication, OCR, or lifecycle/retry. Preserve a synthetic
regression at that stage and rerun the entire camera workflow after the fix.
Record saved-photo improvements independently. An accurate release summary is
"synthetic browser workflow passes; physical-phone acceptance pending" until
physical evidence supports a stronger claim.
