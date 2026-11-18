# Saved scan capture metadata

After an unsuccessful camera scan, **Save scan photo** downloads
`QRed-scan-photo.zip`. It contains the photographed image and `qred-scan.json`.
All metadata capture, export and import happen on the device, offline.

The JSON archive uses `schema: "qred-scan-archive"`, `version: 1`, and a `photos`
array. Each entry names its sibling image, contains a `metadata` record, and says
whether the same record was embedded in that image (`embeddedXmp`). The current
scanner takes one still. Older ZIPs with up to three numbered exposures remain
readable; the first exposure is used, as before.

For an ordinary JPEG, QRed adds or updates an APP1 XMP packet with namespace
`https://qred.org/ns/scan/1.0/` and property `qred:Capture`, whose text is JSON.
It preserves existing EXIF and other segments, merges existing readable XMP, and
never decodes/recompresses pixels to save metadata. Non-JPEG files, compound
MPF/HDR/motion photos, malformed/oversized XMP, and unusually large JPEG headers
use the JSON sidecar without modifying the image bytes. JPEG header inspection
is limited to 1 MiB. Metadata may be removed by image editors or sharing apps;
the downloaded ZIP retains the companion JSON.

## Capture record, version 1

The record has `schema: "qred-scan-capture"` and `version: 1`.

| Field | Meaning |
| --- | --- |
| `app` | Application version and build commit (null if unavailable). |
| `capture.requestedAt` | Device clock timestamp just before the successful shutter request, not a hardware exposure timestamp. |
| `capture.trigger`, `preview`, `guideState` | Manual/automatic trigger, preview dimensions and last capture guide state. |
| `capture.trackSettings` | Allowlisted browser-reported settings immediately before the shutter: zoom, focus, exposure, ISO, white balance, torch, facing direction, preview dimensions/frame rate and resize mode. Unsupported values are null. These preview-track settings are not guaranteed to describe the camera's actual still exposure or identify its physical lens. |
| `capture.photoSettings` | Parameters passed to the successful `takePhoto` call. If optional sizing is rejected, these record the retry's parameters. |
| `image.encodedSize`, `exifOrientation` | Original JPEG dimensions and EXIF orientation, when readable. Missing orientation is null rather than assumed. Native EXIF remains in the image. |
| `image.decodedSize` | Dimensions after the browser opens the photo with its default orientation handling. |
| `processing` | Saved pixels' origin, known QRed corrections and dimensions/orientation of the image supplied to the decoder. `decoderCrop: null` means no crop at this boundary. The working input can be resized to the decoder's 12 MP limit. Internal candidate warps used by seal recovery are not applied to the saved image. Camera-side lens correction is unknown. |
| `calibration` | Null for current captures: browser APIs do not supply calibrated intrinsics or distortion coefficients. The schema can retain a measured Brown–Conrady profile (`model: "brown-conrady"`, `profile`, `imageSize`, row-major 3×3 `cameraMatrix`, and 4, 5 or 8 OpenCV-ordered `coefficients`). Metadata import does not apply it. |

QRed's added fields exclude device/group IDs, camera labels, user agent strings,
location, document contents and verification claims. Existing native image
metadata is preserved, so it may contain fields the camera supplied separately.

## Reopening and verification

**Browse files** accepts both older photo-only ZIPs and the new archives.
**Choose photo** can read the embedded record from an extracted JPEG. A bounded,
recognized sidecar for the exact sibling image takes precedence over XMP.
Unknown versions, malformed/oversized optional metadata and unrelated fields
are ignored; they do not prevent opening a valid photo. Imported metadata is
retained for subsequent saving and diagnostics, not rendered into the UI.

These records are untrusted descriptions, not part of the signed seal. They
cannot supply authenticated text, mark a scan verified or cause automatic lens
correction. Seal recovery and text comparison still process the selected image.
Future correction work must validate calibration against the actual camera,
zoom, resolution, orientation and processing history before using it.

Regression tests cover shutter-time snapshots (including retries and torch
shutdown), EXIF preservation, exact decoded JPEG pixels, existing XMP, PNG bytes,
ZIP/standalone JPEG imports, malformed metadata, cancellation, and the offline
download path on both verifier entry points. Test photos are synthetic.
