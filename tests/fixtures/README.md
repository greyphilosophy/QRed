# Required test fixtures

The normal test suites use committed fixtures and generate their own temporary
documents. Missing files or test dependencies fail the run instead of silently
skipping coverage. Run the suites with the commands in the project README.

## Coverage replacing the old skipped tests

| Check | Required coverage |
| --- | --- |
| Read, stamp, render, and scan a PDF | `frontend/src/pdfClientSeal.test.js` seals the bundled `ascii85-text.pdf`, renders its saved footer with Poppler, recovers the signed text, and verifies its signature. This replaces the downloaded sample and temporary Playwright installation. |
| Show recovered text in the photo analyzer | `tests/test_qred_deployment.py::TestPdfTextSealing::test_zlib_reduces_a_page_to_one_seal_and_verifies_printed_pixels` opens a rendered current-format seal in the real analyzer and checks its text and unverified-signature label. The old QRED1 display test is retired. |
| Reseal a sealed PDF | `tests/test_qred_deployment.py::TestExistingSealCompatibility::test_seal_reseal_compatibility` creates, seals, reseals, and verifies its own document. It replaces the optional `/tmp` sample test. |
| Read JPEG QR pixels | `frontend/src/QrScanner.photo.test.js` always reads the committed blurred JPEG and verifies a signed synthetic PDF render after JPEG compression at qualities 85 and 50. |

## JPEG provenance and limits

`../qred_hidden_payload_photo.jpg` was committed in `bc0f680` on 2026-07-05.
It is a 165-by-165 JPEG with the known hidden payload `IMG`. That payload is
test data, not a signed document. The original test described it as a photograph,
but no camera, print, or capture provenance was recorded. Its regression checks
the existing image pixels without claiming physical-camera validation.

The JPEG-compression cases start from `compact-qr/invoice-footer-300dpi.png`.
That fixed synthetic PDF render has a known signature and public test key;
see [its provenance](compact-qr/README.md). JPEG encoding happens locally in the
test. The recovered seal must verify with that key, contain the expected invoice
total, and fail verification with the wrong key. These are compression tests,
not photographs of paper.

## Adding a physical print/camera regression

A documented photograph of a printed current-format QRed seal is still needed.
Use only synthetic text and a disposable or public test key:

1. Seal the bundled `live-qa-invoice.pdf` through QRed. Keep the resulting PDF
   and its public verification key. Capture footer and pale-watermark layouts
   separately when possible.
2. Print at a recorded scale and photograph the page. Retain the original image
   pixels so the test exercises camera output rather than a cleaned-up render.
3. Commit the non-sensitive image with its expected text/key and a short record
   of the layout, print scale, printer, camera, and lighting. Avoid personal
   account identity, private documents, and personal location metadata.
4. Add it directly to the required scanner regression with an exact recovery
   and signature assertion. Do not add an existence check or an environment
   switch that silently skips the case when its fixture is missing.

Rendering, simulated compression, and injected browser camera frames remain
useful automated checks, but cannot establish physical print/phone reliability.
