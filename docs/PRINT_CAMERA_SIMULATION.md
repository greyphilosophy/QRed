# Reproducible print and camera tests

The simulator turns a **complete, genuinely sealed PDF** into a simulated photograph, then sends that image through the normal browser verifier. It is designed to make printer/phone failures reproducible before another physical trial. It does not establish that a particular printer or phone will work.

`tests/print_camera.py` has no imports from the decoder. It receives only the PDF pixels and simulation parameters. Expected seal bytes and signed text are held separately for assertions; neither the decoder nor OCR receives them as hints.

## Image formation

1. Poppler renders the entire PDF page, including its text and real production watermark or footer, at 150, 300, or 600 printer DPI. Printable dimensions are checked before rendering.
2. Printer fit/offset is applied before screening. Dispersed ordered dots, clustered dots, or error diffusion generate ink/no-ink spots. Partial dot expansion and seeded missing spots approximate dot gain and dropout.
3. An independently solved perspective transform places the physical paper over a dark, pale, or patterned background. Exposure, gradients, shadow, glare, and color tint affect the scene.
4. Optical and motion blur precede sensor area sampling. Read/shot noise, the sRGB transfer curve, sharpening, and JPEG compression follow. Spatial operations after printing use approximate linear reflectance, not gamma-encoded gray averages.
5. The browser loads the resulting real JPEG or PNG. The orientation case stores rotated JPEG pixels plus EXIF orientation 6. Higher-resolution stills are rendered independently from the printer raster; they are not enlarged preview frames.

The intermediate printer PNG is **linear reflectance**, useful for inspecting dots at 100% zoom. Its displayed brightness is not a prediction of paper appearance. `tone=1` preserves the intended tone when spots are averaged; `tone`, dot gain, and dropout can be varied independently.

## Generate and replay a case

Install Poppler (`pdftoppm` and `pdfinfo`), Node 24, and the Python requirements:

```bash
python -m pip install -r requirements.txt
cd frontend
npm ci
node node_modules/vite-node/vite-node.mjs scripts/prepareSimulationDocuments.mjs
cd ..

python tests/print_camera.py simulation-results/documents/plain-sealed.pdf \
  --profile reference --save-print --out simulation-results/example

python tests/print_camera.py simulation-results/documents/dense-sealed.pdf \
  --sweep --out simulation-results/generated-sweep

python tests/print_camera.py simulation-results/documents/plain-sealed.pdf \
  --profile simulation-results/example/reference.json --out simulation-results/replay
```

Each case records the full profile, random seed, PDF page, input/output SHA-256, simulator source hash, printer raster dimensions, and Python/Pillow/NumPy/Poppler versions. Browser results also record the browser version. Replay uses the saved page and rejects a different input PDF. Keep the original PDF and matching runtime versions for byte-exact replay. `--seed` deliberately generates a new noise/dropout realization. A profile JSON can also contain just the `printer`, `scene`, `camera`, and `seed` settings; unknown keys fail instead of being ignored.

The generator uses the existing public **demo** signing key, synthetic content, and a fixed date. It creates a two-page readable invoice, a dense invoice with ordinary text/table/logo overlaps, and a multipart footer document. A fourth PDF changes an amount on the already sealed second page without re-signing it. No private photographs, customer content, or private operational keys belong in these fixtures.

## Run production verification

Build and serve the app, then run the acceptance suite in a second terminal:

```bash
# First terminal
cd frontend
npm run build
node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 3000

# Second terminal, repository root
python -m playwright install chromium-headless-shell
QRED_BASE_URL=http://127.0.0.1:3000 pytest -v \
  tests/test_print_camera_model.py tests/test_print_camera_browser.py \
  --junitxml=simulation-results/junit.xml
python tests/report_print_camera.py simulation-results
```

Set `QRED_SIM_SWEEP=1` to run every camera/print preset; the normal suite uses reference, clustered 600-DPI, diffusion 150-DPI, and the observed-scene envelope. `QRED_SIM_OUTPUT` changes the browser suite's artifact directory. Use a fresh output directory when comparing runs so old reports cannot be mistaken for new results.

The separate **Printed camera workflow acceptance** CI job runs on PRs. Manual workflow dispatch enables the full sweep. Even on failure, it uploads `qred-print-camera-simulation`: source/sealed PDFs, photographs, parameter manifests, JSON measurements, screenshots, JUnit results, a Markdown report, and a contact sheet. The original readability and workflow tests remain enabled.

## What the assertions mean

| Check | Required outcome |
| --- | --- |
| Printer model invariants | Tone conservation, real spots, deterministic replay, sampling/detail loss, dot gain/dropout, physical page fit, resource limits, EXIF rotation |
| Unchanged simple page | Exact signed seal and content recovered; zero content-difference groups |
| Altered amount on page two | Original signature still authenticates; changed/missing signed amount requires review; document collection completes |
| Dense reference page | Exact signed page recovered; OCR differences recorded separately |
| Multipart footer | Every expected seal chunk recovered and the whole signed text authenticated; partial recovery is a failure |
| Unsealed page | Retake guidance, with no authenticated page |
| Both camera routes | Automatic capture, stationary duplicate suppression, next-page capture, completion/stop, retake retaining the acknowledged still, and cleanup |
| Offline operation | After resources are prepared, no network attempts |
| Exploratory stress profiles | Every miss, incomplete seal, timeout, latency, and OCR result is reported; completing the sweep does not mean those cases passed |

Camera fixtures substitute the hardware interfaces with a real canvas MediaStream and an independently simulated still photograph. They do not replace decoding, signature verification, OCR, or the UI's capture logic. The upload test uses the home verifier's existing image picker; `/verify.htm` currently has PDF input and camera capture but no image picker.

A scanner result must arrive within 20 seconds in the browser harness; failure to do so is recorded as a timeout. These wall-clock measurements include browser processing and are not device performance predictions. An amount that OCR cannot read must still require review; the changed-amount assertion does not claim that OCR accurately transcribed the replacement amount.

## Known boundaries and current failures

The first runs against PR 168 recovered the simple page's exact seal but produced five content-difference groups on unchanged text. They also missed the dense invoice's seal under several profiles. These are strict acceptance failures, not skipped or expected-failure tests. Until they are addressed, the new job may be red even when the older suite is green. Inspect each run's artifacts for current numbers rather than treating this initial observation as a permanent baseline.

The `observed-scene` preset uses approximate framing, paper brightness, 12-megapixel dimensions, and EXIF orientation from two physical phone photographs. It contains no original pixels or text. Those same photographs informed the preset and are therefore calibration references, **not independent validation**. The printer screen, dot gain, optics, and noise remain approximate.

The model does not yet cover curved paper, lens distortion, autofocus dynamics, rolling shutter, Bayer demosaicing, color printer separations, paper texture/bleed-through, or a measured printer tone-response curve. More presets are not a substitute for calibration. Add a measured printer/phone profile from paired known PDFs and captures, and reserve separate real captures for validation. Physical acceptance remains governed by [the readability requirements](WATERMARK_READABILITY_REQUIREMENTS.md).
