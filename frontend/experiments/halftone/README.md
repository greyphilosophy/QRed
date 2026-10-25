# Experimental dotted page carrier

This standalone experiment tests whether a page image can carry a full QRed
seal in small black dots and white holes. It does not change either production
app. All input is synthetic; no user document is read.

The proof of concept succeeds on clean digital images with the current scanner.
It is **not ready for production**: all dotted variants fail the tested projective
tilt, smaller dots are fragile, and dots disrupt fine text. No physical printer or
phone camera has been tested.

## Reproduce

From `frontend`, after installing the project's Node dependencies:

```sh
# Node 24; Python with Pillow; system DejaVu Sans/Mono fonts.
QRED_EXPERIMENT_PYTHON=python3 node experiments/halftone/run.mjs /tmp/qred-halftone

# Optional raw OCR diagnostic: requires Tesseract with English data.
python3 experiments/halftone/check_text.py /tmp/qred-halftone

# Optional four-page print sheet: also requires ReportLab.
python3 experiments/halftone/make_sheet.py /tmp/qred-halftone /tmp/qred-print-test.pdf
```

The runner bundles the existing sealer, QR generator, scanner and verifier into
a temporary harness. It writes progress after every case; a partial run has
`complete: false`. Failed degraded samples are expected experimental outcomes,
so inspect `results.json`, not just the process exit status. Every conventional
QR control should pass. The print-sheet builder checks those controls.

## Method

- One deterministic, signed v3 QRed payload fills exactly 2,945 bytes in one
  version 40-L QR (177 by 177 modules). Plaintext is explicitly selected to fill
  capacity; this does not change production compression. The seed is QRed's
  published demo key, never an authority key.
- The same seal is placed on a synthetic grayscale stress chart and a synthetic
  text page. The chart is not a photograph. Its picture is not authenticated by
  the test payload: this experiment tests transport, not image verification.
- Original luminance is mapped to approximately 5%-95% (13-242). At each module
  center a circle is set to full black or full white according to the QR matrix.
  Those extremes are not assumed to remain unique after printing.
- At 300 dpi, 12 pixels per module gives a 7.08-inch active code, or 7.40 inches
  including the four-module white border. Nominal dot diameters are 0.34 mm
  (one third of a module) and 0.51 mm (one half).
- `all` draws every reserved QR function module conventionally. `minimal` keeps
  full finder corners, timing/format/version areas and the bottom-right alignment
  target; other alignment modules use dots. Both retain the original matrix bits.
  These are experimental renderings, not a general scanner-compatibility claim.
- Controls draw all modules as conventional full black/white cells.
- The unmodified `scanQrImage` first attempts native resolution without rescaling
  or watermark processing, then uses its normal retry pipeline if necessary.
  It receives no known module coordinates or inverse transform. A pass requires
  byte-for-byte recovery of the hidden seal, a valid signature, and the exact
  original signed text. Reading only `QRED.ORG` does not count.

Five conditions are applied to each carrier:

| Condition | Transformation |
| --- | --- |
| Clean | Original 2,220-pixel square PNG |
| Resize (`photo`) | 1,110 pixels across, Gaussian blur 0.6 px, JPEG quality 85 |
| Low resolution (`small-photo`) | 740 pixels across, the same blur and JPEG |
| Angle (`perspective`) | Projective quadrilateral in a 1,250-pixel canvas, roughly 1,100 pixels across the code, blur and JPEG |
| Ink spread (`print-spread`) | Floyd-Steinberg monochrome halftone, one-source-pixel black expansion, then the resize/blur/JPEG treatment |

The ink-spread case is a severe simplified model, not a calibrated prediction of
any particular printer. The names `photo` and `small-photo` denote simulations,
not actual photographs.

## Recorded run: 25 October 2026

The baseline is commit `2baf911b580cdb59f30365bdbd7236a5bb6c293b`. There are
50 completed cases: two covers, two dot sizes, two marker styles, plus controls,
under five conditions. Both marker styles have the same pass/fail outcomes:

| Cover / dot diameter | Clean | Resize | Low resolution | Angle | Ink spread |
| --- | --- | --- | --- | --- | --- |
| Image / 0.34 mm | Pass | Pass | Fail | Fail | Fail |
| Image / 0.51 mm | Pass | Pass | Pass | Fail | Pass |
| Text / 0.34 mm | Pass | Fail | Fail | Fail | Fail |
| Text / 0.51 mm | Pass | Pass | Pass | Fail | Fail |
| Conventional QR / either cover | Pass | Pass | Pass | Pass | Pass |

The minimal-marker versions overwrite about 10% and 24% of the active QR area
with carrier marks respectively (excluding the separate contrast remapping).
Full markers increase those values to about 13% and 26%.

Raw Tesseract OCR, with identical crops and no grid removal, has a whitespace-free
character error rate of 0.26% on the original text and 51.75% on the small-dot,
minimal-marker text. Other dotted variants are worse. This diagnostic includes
spurious punctuation; it is not a measure of human readability or an implemented
document-comparison system.

The generated PDF was also rendered with Poppler at 300 dpi. All three complete
test pages recovered the exact hidden payload and valid signature on the first
scanner attempt. This checks PDF delivery, not physical printing.

Recorded machine-readable observations are in `observations/`: the full 50-case
run, raw OCR comparison, PDF scan results and runtime versions. Timings are
informational. These results cover one payload/mask and two synthetic images;
they are not a statistical reliability estimate.

Next validation needs multiple payloads, realistic images/text layouts, real
laser/inkjet prints, camera angles, lighting and devices. Fine-text preservation
and reliable angled scanning must improve before exposing this as a seal option.
