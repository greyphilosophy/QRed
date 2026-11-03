# Conditional hex-spoke watermark experiment

This is an **experimental carrier and reader**, stacked on the print/camera
simulator in PR #169. It does not change the production renderer, browser
scanner, simulator, error correction, authentication, or acceptance thresholds.
See [RESULTS.md](RESULTS.md) for the original measured outcome and limitations.
The later [PR 171 OCR comparison](OCR_PR171.md) reruns identical images with the
new OCR reference/retry interface; it does not change the optical pass counts.

## Encoding

The same production-generated, signed QR message is used for every carrier.
Its complete QR matrix is serialized row by row onto a regular hexagonal grid.
The grid's row/column counts maximize regular cell pitch inside the same
504 by 684 point rectangle on US Letter paper, with 0.75 inch margins.

* A white logical cell is blank.
* A black cell has a center dot, including when it has no black neighbors.
* Six possible arms point toward the midpoint of a side and report the six
  immediate neighbors.
* Six more possible arms point toward a vertex and report the next six centers
  along those directions: distance `sqrt(3)` times the nearest-neighbor pitch.
* An arm exists only when **both its source and target bits are black**.
* Strokes end inside their own hexagon. There are no long crossing edges.

The twelve directions alternate at 30 degree intervals. These are conditional
AND observations, not twelve independent payload bits or twelve guaranteed
copies of a bit. The farther neighbors are not the six cells at distance two
along the side directions. The geometry tests enforce this distinction.

Dots and arms are painted as one nonzero-winding path so multiply blending does
not darken overlapping junctions. The reference carrier shade is 85% gray,
dot radius is 0.12 pitch, and line width is 0.11 pitch. Arm length is 86% of the
center-to-side or center-to-vertex distance; round caps remain inside the hex.

## Reader and controls

Four 22 point ArUco markers with quiet zones are added to **all experimental
carriers**, including the rectangular control. Their IDs contain only QR
version, carrier kind, and corner number. They contain no payload, signature,
source pixels, expected bits, printer settings, or camera geometry. This is
extra registration overhead and a limitation of this prototype.

The optical reader receives only the camera image. It locates the markers,
estimates a homography, normalizes local paper color, measures centers and
oriented strokes, and treats darker document ink as missing evidence. For
hexagons it also samples the gaps between possible arms to distinguish hubs
from shaded table backgrounds. Missing strokes are not negative evidence
unless a black source is confidently observed and the stroke area is visible.
Neighbor votes are capped and use a single pass to limit correlated feedback.

Measured matrices go through existing QRed QR Reed-Solomon/bit-erasure recovery,
transport decoding, digest checking, and Ed25519 verification. Only after that
does the harness compare with the expected payload. Signature success alone is
not treated as proof that the printed words match the signed words.

The experiment includes dots-only and six-arm ablations, source-only and
registration-only negatives, a paler 94% gray trial, and the actual unmodified
production PDF/reader for a separate reference comparison. The experimental
rectangular sampler is **not** the production scanner. Its registration tags
can cover QR finder modules; do not use its results as the native scanner's
performance. Different carriers have the same ink shade, payload, and usable
page area, but not equal total ink coverage. This is not an equal-ink study.

No expected text is passed into OCR. The existing production OCR reader and
text comparison are called in Chromium on the camera image. A diagnostic
rectified-image pass is recorded separately. This is not a browser workflow,
live-camera interaction, offline, multipart, or tamper acceptance test.

## Reproduce

Install the normal frontend dependencies and the experiment's Python packages:

```sh
python3 -m venv .venv
.venv/bin/pip install -r experiments/hex_spokes/requirements.txt
cd frontend
npm ci
node scripts/prepareOcrAssets.mjs
node scripts/preparePdfAssets.mjs
node node_modules/vite-node/vite-node.mjs scripts/prepareHexSpokeDocuments.mjs
cd ..
.venv/bin/python experiments/hex_spokes/render.py simulation-results/hex/documents
.venv/bin/python experiments/hex_spokes/run.py --require-all
```

The last command performs exact-payload acceptance and deliberately exits
nonzero when any requested optical case fails. It always saves the measurements,
verification results, and result table. A zero exit from rendering or photo
generation alone is not a decode pass. The default reference run includes all
four carriers on both documents. The public demo signing key must never be used
for real documents.

The untouched simulator provides all nine presets. Seed 168 was used during
development; the frozen 85% gray reader/rendering settings were evaluated with
seed 911 without adapting them to those results:

```sh
.venv/bin/python experiments/hex_spokes/run.py \
  --kinds rect hex12 \
  --profiles reference clustered preview still pattern-shadow pale-desk low-dpi blur-compression observed-scene \
  --seed 911 --output simulation-results/hex/holdout --require-all
```

Each photo retains the simulator's source/photo hashes, full profile, seed,
runtime versions, and simulator hash. `--reuse` refuses a cached photo whose
source, profile, or image hash differs. Verification outputs are bound to the
hash of their measured input; stale verification cannot count as a pass.
Reported fixture `seconds` include simulation and optical work, and are not a
measurement of scanner latency or the browser's scan deadline.

Run the existing OCR/comparison separately; install Chromium with Playwright
first or pass `--chromium /path/to/chromium`:

```sh
.venv/bin/playwright install chromium
.venv/bin/python experiments/hex_spokes/browser_check.py \
  simulation-results/hex/development/plain-hex12-reference-168.jpg \
  simulation-results/hex/development/dense-hex12-reference-168.jpg \
  --manifest simulation-results/hex/documents/manifest.json \
  --output simulation-results/hex/development/ocr.json --start-server
```

`--production-scan` additionally invokes the normal production scanner. Use it
on production-format photos; the deployed scanner does not understand hexes.
`controls.py` generates the source-only and registration-only cases with the
same simulator. The checked-in evidence is synthetic only. No user photos or
private keys are included.

## Validation and next work

```sh
.venv/bin/python -m unittest discover -s experiments/hex_spokes -p 'test_*.py'
.venv/bin/python -m pytest tests/test_print_camera_model.py -q
cd frontend
npx vitest run src/qr/qrErasureRecovery.test.js src/qredQr.test.js src/qredVerifier.test.js
```

The next optical work is distinguishing resolved printer halftone dots from
foreground ink and improving marker registration under blur. Independently,
OCR needs work even for the unwatermarked controls. A full acceptance pass and
production browser integration remain required before calling this ready for
ordinary printing and scanning.
