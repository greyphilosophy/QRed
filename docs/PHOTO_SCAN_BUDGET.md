# Photo scan time budget

A captured or selected photo has a 60-second seal-decoding budget. A successful
read can finish immediately. The user can cancel during any recovery step. The
synchronous decoder checks its deadline between attempts; conventional jsQR calls
also receive cooperative checkpoints inside expensive loops. A separate watchdog
in the caller terminates the worker if synchronous work overruns the overall
budget. Preparation and some recovery routines remain indivisible. A timer inside
the decoder worker would not interrupt such work.

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
it prompts the user to retry or choose a photo. Generic QR preview scans use
their own frame loop.

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
larger upload repeatedly inside the seal-reading budget. It also
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
These measurements used the previous eight-second budget. This optimization does not establish
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
was consumed by preceding attempts. These measurements used a four-second
narrow-pass cutoff. The narrow pass gets half of the current budget, up to 30
seconds. The remaining recovery steps share the time left on the same clock.

## Curved and tinted paper

For a full-page watermark the rectified reader can use the three measured finder
positions to constrain the grid when an extrapolated corner drifts. If ordinary
and footer recovery also miss, the scanner follows the four paper edges on a
small preview and fits their curvature before sampling the original photo.
This still-photo attempt gets at most one third of the shared budget. The final
general QR stage reuses observed pixels across consecutive filter radii at the
same scale and measures the paper tint before rejecting colored pixels.

## Conventional-code preflight

The early conventional-QR pass is a preliminary look, not a pair of exhaustive
12 MP reads. It uses at most 1.5 MP, a cheap pixel-center preview, and at most two
attempts (the second only masks a detected navigation QR). Its cooperative
allowance is one quarter of the photo budget, up to 15 seconds with the current
default, and ends earlier if the overall deadline expires. Preparation is checked
before entering the decoder, and navigation masking cannot start fresh work
after the allowance expires.

The existing jsQR patch now accepts an optional deadline callback, checked inside
binarization, image location and candidate loops as well as around bounded QR
extraction/decoding. A cancelled attempt returns no partially decoded result.
Unrelated errors still propagate. Without that callback, the established math,
recovery criteria and output remain unchanged. The independent worker watchdog
is still required: these checkpoints are cooperative, not a hard real-time
promise, and other image preparation/recovery work also consumes the budget.

Point sampling can miss a dense footer that the original photograph can read.
It is therefore limited to this early conventional pass. The original photo is
unchanged and remains available to footer isolation, wider watermark recovery,
page alignment and the final general-code fallback. Default/full-detail QR
scans and filtered watermark preparation keep their existing resampling.
Tests explicitly preserve a full-page dense invoice whose quick preview misses
the seal, checking original-pixel footer recovery, valid signature and rejection
of a wrong authority. Browser upload and camera workflow gates remain required.

A timeout checkpoint saying conventional-code reading began at 1.3 seconds does
not measure its duration or prove the selected photograph is optically readable.
It does identify a stage where a full-resolution synchronous miss previously
could use the remaining budget before wider watermark recovery. Reserving that
stage's time fixes the scheduling mechanism; successful recovery of any specific
unprovided phone capture still requires a physical test.

Local diagnostic evidence for this scheduling change used public synthetic
invoice pixels and the actual built worker/library, not a phone emulator:

- With a deliberately short 500 ms inner allowance, the previous jsQR ignored
  the callback and finished after 722, 1579 and 2672 ms at normal, 50% and 25%
  decoder-process duty respectively. The patched implementation cancelled after
  500, 509 and 523 ms. Only the decoder process was paused; elapsed wall time
  continued normally. These one-shot component probes establish cancellation,
  not successful seal recovery or phone latency.
- Two interleaved production-worker runs per variant used the original 10.7 MP
  public invoice and a 3000 by 4000 framed version. At normal speed both variants
  completed all four reads; observed decoder times were 2.91–4.34 seconds before
  and 1.75–3.42 seconds after. At 50% process duty both completed three of four;
  at 25% neither completed any of four. Every failure is retained. Earlier
  watermark processing and other stages can still exhaust the overall budget.
- A deterministic clock test runs real jsQR inside `decodePhoto`, expires the
  conventional allowance during internal processing, and proves later recovery
  is invoked. This is a scheduling regression, explicitly not optical evidence
  or a performance measurement.

Do not convert these workstation/process-pressure results into a claimed phone
success rate. The readable synthetic footer still has an eight-second browser
performance check. Record physical-phone capture and seal-reading times separately.
