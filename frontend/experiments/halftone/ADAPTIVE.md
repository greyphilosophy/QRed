# Adaptive three-tone experiment

This implements the proposal to choose black or white to match the underlying
pixel, adding a 50% gray state. It remains separate from production sealing and
scanning. The live qred.org reader cannot read this experimental carrier.

## Mapping and byte budget

| QR matrix bit | Printed dot pixels |
| --- | --- |
| 0 (logical white) | Either black or white, whichever is nearer each original pixel |
| 1 (logical black) | Nominal 50% gray, digital luminance 128 |

There are three physical tones but only **two logical values**, hence one bit
per cell. No per-dot polarity map is needed. The complete existing 2,945-byte
signed seal is unchanged. Gray is not an additional payload value or an erasure.
The original 5%-95% remapping and dot dimensions are retained. Finder corners,
timing, format/version areas and one alignment target stay conventional.

On a light area, dots are white or gray. On a dark area, they are black or gray.
For data dots, the largest nominal brightness change is roughly half the scale,
rather than potentially the entire scale. Midtones, text edges and full-size
function markers still create visible changes. Equal digital steps are not
necessarily equal perceived or printed brightness steps.

## Custom reader

`adaptive_reader.mjs` exposes the installed, patched jsQR 1.4.0 locator,
projective extractor and decoder in memory; it does not modify dependencies or
the production patch. Its grayscale sampler uses only input pixels and
detected geometry. It has no original image, expected matrix, known page bounds,
or inverse rendering transform.

The locator estimates the QR dimension and the reader also tries adjacent valid
dimensions, matching the production decoder's approach. A template for that
dimension supplies reserved-cell locations only. Finder patterns supply black
and white reference samples. Data-cell center samples between nominal 25% and
75% are mapped to bit 1; samples near either extreme map to bit 0. A bounded
three-phase sampling retry is used. The ordinary QR Reed-Solomon decoder then
recovers data. The harness independently checks exact hidden payload bytes,
the signature and the full signed text.

There is no gamma or local illumination calibration, no printer response model,
and no grid refinement beyond the existing finder/alignment geometry. In
particular, a dot straddling a text edge can have a center sample that changes
substantially after blur. The reader's bundled-module export adapter is pinned
to jsQR 1.4.0 and fails explicitly if that bundle layout changes.

## Reproduce

Use the same Node 24, Pillow and DejaVu font prerequisites as the binary experiment.

```sh
QRED_EXPERIMENT_PYTHON=python3 node experiments/halftone/run_adaptive.mjs /tmp/qred-adaptive-gray
python3 experiments/halftone/check_text.py /tmp/qred-adaptive-gray adaptive
python3 experiments/halftone/make_adaptive_sheet.py /tmp/qred-adaptive-gray /tmp/qred-three-tone-comparison.pdf
```

OCR additionally requires Tesseract English data; the PDF requires ReportLab.
The runner creates 20 adaptive cases and 10 conventional QR controls. It fails
if a control fails; adaptive failures are observations, not runner errors.

## Observations

Same payload, covers, dot sizes and five distortions as the binary baseline;
one payload/mask is not a reliability estimate. Both variants use minimal
conventional markers. All four regenerated binary comparison images were
pixel-identical to the earlier fixtures.

| Adaptive carrier | Clean | Resize | Low resolution | Angle | Ink spread |
| --- | --- | --- | --- | --- | --- |
| Image / 0.34 mm | Pass | Pass | Fail | Fail | Fail |
| Image / 0.51 mm | Pass | Pass | Pass | Pass | Fail |
| Text / 0.34 mm | Pass | Fail | Fail | Fail | Fail |
| Text / 0.51 mm | Pass | Fail | Fail | Fail | Fail |
| Conventional QR / either cover | Pass | Pass | Pass | Pass | Pass |

All 30 cases completed: 8/20 adaptive cases and 10/10 controls passed. Clean
images pass with exact payload and signature recovery. The larger image carrier
now passes the tested angle, but both its rendering and reader changed, so this
does not isolate the cause. Text robustness is worse than the binary baseline
for the larger dots. Every adaptive ink-spread case fails.

| Raw OCR, whitespace ignored | Character error rate |
| --- | --- |
| Original | 0.26% |
| Binary / 0.34 mm | 51.75% |
| Adaptive / 0.34 mm | 20.86% |
| Binary / 0.51 mm | 90.11% |
| Adaptive / 0.51 mm | 52.10% |

OCR includes spurious punctuation and is not a human readability score. Even
the improved carrier materially harms OCR. Mean absolute pixel change across
the active image is 21%-39% lower for these adaptive examples, including the
unchanged contrast remapping and markers; that is a pixel metric, not a
perceptual quality guarantee. Detailed results are in `observations/adaptive/`.

The PDF is for visual inspection and future print experiments; it is not a file
the live scanner can verify. Its chart is synthetic and the seal signs test text,
not the picture. In a 300 dpi Poppler render of each full PDF page, the larger-dot
image page decodes correctly, but the small-dot text page fails even though its
source PNG decodes. This is another sign of sampling/alignment fragility, not a
physical printing test. No physical printing has been tested.

## Remaining work

Preserving and classifying the middle tone through printer halftoning, ink
spread, camera blur, exposure and gamma is the main unresolved problem. Strict
black/white thresholding can erase this distinction. Future work should test
local calibration and edge-aware sampling against multiple payloads and real
printers before considering production support. Ordinary QR navigation would
need its own conventional code.

Related research on optimizing image appearance and QR sampling includes
[Halftone QR Codes (2013)](https://cgv.cs.nthu.edu.tw/projects/Recreational_Graphics/Halftone_QRCodes)
and [ART-UP (2018)](https://arxiv.org/abs/1803.02280). They motivate checking visual
quality and decode robustness together; the specific three-tone mapping here
is this project's experiment, not an implementation or validated claim from
either paper.
