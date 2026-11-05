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

## Camera photographs, not preview frames

In document-capture mode, video frames only drive framing and steadiness. A
ready page hands off to the browser's `ImageCapture.takePhoto()` API. Unsupported,
failed, timed-out or undersized photo acquisition stops before seal decoding;
it never silently substitutes a preview frame and spends another eight seconds
trying to read it. Generic non-document QR preview scanning is unchanged.

Native photo acquisition has a separate cancellable five-second total allowance,
not a five-second delay. Successful photos continue immediately. The previous
1.8-second cutoff was an application policy, not a browser limit, and could
abandon a photo that would finish shortly afterwards. Capability lookup, one
optional-settings retry and bitmap decoding all share the same allowance.
The browser API cannot cancel a pending hardware request; late results are
ignored, and only one native request per track may remain outstanding. If the
camera never settles, reopening it creates a fresh track.

The target remains a photo up to 12 MP. Automatic full-page capture requires at
least 4 MP and 2560 pixels on the long side in the actual returned image, not
merely in requested settings. This operational floor is motivated by the
smallest successful measured full-page replay before the later low-resolution
recovery improvements. It is not a readability guarantee or an authenticity
check. Camera processing, focus, lighting and page occupancy still matter.
Seal decoding receives this capture before the existing 6 MP cap is applied to
the separate session-only review/OCR copy.

Missing or explicitly unsupported optional capability discovery can fall back
to `takePhoto` without resolution preferences. Rejected advertised dimensions
can retry once without sizing, keeping flash off. Permission, security and
camera-operation failures are not retried. Separate advertised width/height
ranges do not enumerate supported resolution pairs. Browser/device support and
photo processing vary; using the photo API does not promise a particular sensor
mode. See [Chrome's photo API overview](https://developer.chrome.com/blog/imagecapture)
and the [W3C capture algorithm](https://www.w3.org/TR/image-capture/#dom-imagecapture-takephoto).

Camera interfaces offer explicit local photo selection if native acquisition
is unavailable. This does not automatically open a phone camera app, save to the
photo library or upload images. The main page also retains its general-purpose
existing image input for ordinary QR images. That input also serves the main
camera's **Choose photo** button. All selected-photo routes now use the same
12 MP working-copy limit before seal decoding, including photos only slightly
above 12 MP. The general-purpose input keeps smaller QR images at their original
size and does not impose the full-page minimum-resolution requirement.
Close, Cancel, replacement and
Finish & clear discard pending work and cannot publish late pixels/results.

If seal reading fails after a photo is submitted, the interface shows the
source and working dimensions. If the 12 MP cap resized the decoded source
photo, its original dimensions are shown separately. The preparation time
includes native acquisition or file decoding plus canvas preparation, before
the seal-reading budget starts. Neither pixel count nor preparation time proves
that the captured watermark is sharp or readable.

The selected-photo cap reduces canvas/readback memory and avoids resizing a
larger upload repeatedly inside the eight-second seal-reading budget. It also
keeps selected working pixels eligible for the decoder's bounded native-sampling
fallback. This does not raise the time limit or prove that an unreadable photo
will decode. File opening and canvas preparation still occur before that budget;
their reported time must not be mistaken for seal-decoding time. Cancel discards
a still-opening file immediately without waiting for image decoding to settle.

Native capture failures during seal reading also retain whether the trigger was
manual or automatic, the actual preview dimensions, and the last allowlisted
guidance state before the photo. This records what the gate last reported; it
does not infer a camera fault or claim the later live preview matches the
captured photo. Explicitly selected files do not inherit camera guidance.

On a seal-reader timeout, a fixed-name checkpoint identifies the last reported
decoder step and when it began relative to decoding. These checkpoints do not
extend the watchdog, settle a request, or replace partial recovered chunks.
They do not establish why that step failed or show exactly where execution
stopped. In particular, the watchdog includes worker startup; checkpoint time
begins inside the decoder. If no checkpoint arrived, no stage is invented.

Acquisition failures report a fixed reason and say no video frame was scanned.
These details remain in the camera session; no device labels/IDs, exception
text, document content or pixels are logged, stored or transmitted by the
diagnostic. A screenshot after a failed manual capture may show a later live
preview, not the pixels processed in that attempt. Physical-phone reliability
remains separate from mocked browser/API tests and saved-photo replay.

## Geometry preview work

The page-edge detector uses a bounded working preview while watermark sampling
retains the original pixels. Source-column indexes and row bounds are now
calculated once instead of repeating them for every neighbor of every output
pixel. The four-neighbor sample order and intermediate clamped rounding are
unchanged. Exact-byte oracle tests compare the previous implementation with
the optimized one for landscape, portrait, tinted and narrow images.

In eight alternating local Node runs on one 12 MP photo, preview construction
took 233–260 ms before and 135–242 ms after (medians 242 and 154 ms). Three
whole-photo decode runs took 612–775 ms before and 532–697 ms after, recovering
the identical transport. These workstation saved-photo measurements include
normal runtime variation; they are not a browser camera or phone benchmark.
The eight-second budget is unchanged. This optimization does not establish
that a reported manual-capture timeout or automatic-acquisition failure is
fixed; those require their own reproducible workflow evidence.

## Reusing measured photo work

The narrow and wider rectified passes now share one request-local scanner. It
retains paper geometry and completed profile preparation (warp, normalized
pixels, measured finders/version), instead of rebuilding them for the same
frozen photo. Native normalization and completed sharpening are also reused.
Interrupted sharpening returns no buffer and is not cached. The cache is never
shared between photos, and the wider search still measures its own alignment
markers. At most three 900-pixel-square profiles can be retained, approximately
12 MB, plus the existing bounded native grayscale buffers. The worker's normal
completion/cancellation/deadline releases this request state.

Alignment searches cache only each marker's small luminance neighborhood, with a
65,536-pixel limit (512 KiB of double-precision values); larger neighborhoods use
direct reads. Sample coordinates, arithmetic order, tie-breaking and the measured
grid stay unchanged. A small lookup table also reuses the exact gain correction
for each possible input byte in the geometry preview. All four intermediate
clamped writes still occur. Neither optimization lowers resolution or changes
recovery thresholds, signature checks, stage order or either time allowance.

Tests check exact preview bytes (including 3000 by 4000 and clipped tint gains),
reference grid coordinates for fractional/tinted evidence, bounded allocations,
source-pixel read counts, expired calls, request isolation, and narrow/wide
preparation reuse. Existing perspective, shadow, text, native-sampling, corruption
and wrong-authority tests remain required. Work-count and exact-output checks are
preferred to fragile millisecond assertions in unit tests.

An interleaved local production-bundle comparison used two earlier 12 MP photos,
three runs per variant at normal speed and at 25%/20% process duty. Only the
separate decoder process was paused with SIGSTOP/SIGCONT; a supervising process
kept an independent eight-second wall-time watchdog. This is CPU-pressure testing,
not a simulation of a particular phone, browser or camera. The same input bytes
and recovered transport hashes were used in both variants, without uploading
private photographs or payloads.

At normal speed, median decoder times changed from 1.089 to 0.904 seconds on one
photo and 0.707 to 0.473 seconds on the other. At 25% duty, completed reads changed
from 1/3 to 2/3 and 2/3 to 3/3 respectively. At 20%, they changed from 0/3 to 1/3
and remained 3/3. All failed trials are included. Host scheduling varied noticeably,
including an unthrottled baseline outlier and a delayed supervising timer. These
small samples demonstrate useful headroom, not a reliability rate or phone latency
promise. The current failed selected photo was not identified from its screenshot,
so these results do not establish that that failure is fixed.

A checkpoint such as “refining the page grid (7.7 s into decoding)” reports when
that stage began, not 7.7 seconds spent refining. It can mean almost all the budget
was consumed by preceding attempts. The existing four-second narrow-pass cutoff
and expensive fallbacks can still produce timeouts under heavier CPU pressure;
this change does not replace physical-phone acceptance or justify a longer wait.
