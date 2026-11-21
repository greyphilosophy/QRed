# Fictional solid-banner regression

These are invented workshop completion notices, not copies of a real letter.
They contain no real applicant, agency, result or source photograph. All three
PDFs have identical extracted text and text positions, including the centered
caption **Orientation Complete** and batch reference **DEMO-2037-46**.

| Source | Banner | Caption |
| --- | --- | --- |
| `QRed_White_Background_Control.pdf` | White, 22 pt high | Black |
| `QRed_Black_Bar_Test.pdf` | Black, 22 pt high | White |
| `QRed_Tall_Black_Bar_Test.pdf` | Black, 48 pt high | White |

The page is US Letter, 612 x 792 pt. Every banner is 528 pt wide, starts
42 pt from the left edge, and is centered 353 pt from the top. The PDFs are
unsealed inputs. `generate.py` reproduces them with ReportLab, PyMuPDF and
Liberation Sans; its additional PNGs and manifest need not be committed.

`expected.json` stores one genuine QRed seal made from the control document,
using the repository's public test key and a fixed timestamp. The seal is
deliberately identical across all three renderings: changing the payload
would also change QR geometry and error placement, confounding this test.
The tests stamp it with the production renderer at a 54 pt page margin.
Expected bytes are assertion oracles only; no expected text, payload, PDF
layout or saved page bounds are passed to the still-photo decoder.

## Failure captured

At base revision `55910cb39630a3f05dd880e5463b74c5ec68c2d3`, using this exact
seal and grid, page-aligned recovery produced:

| Input | Clean PDF raster | Simulated print/photo softening |
| --- | --- | --- |
| White control | Pass | Pass |
| 22 pt black bar | Pass | Fail |
| 48 pt black bar | Fail | Fail |

The black bar hides watermark samples and can also conceal all paper probes
in a local brightness tile. Treating that tile's black value as paper makes
adjacent exposed watermark cells appear white. Restoring a local paper
estimate, then using measured mixed error/erasure and ranked-bit recovery,
recovers the exact signed bytes in all six cases. This is a synthetic
regression; it does not establish a physical printer/phone success rate.

## Run

From `frontend/`:

```sh
npx vitest run src/qr/blackBanner.integration.test.js src/verifier/photoOcr.blackBanner.test.js
```

The integration test covers the production watermark renderer and preflight,
clean and softened rasters, actual framed still-photo decoding, signature
verification, cancellation, and complete occlusion without invented output.
The OCR test uses the installed offline Tesseract model and production image
preparation, localized retries and comparison. It verifies the full white
caption, then changes it to **Orientation Incomplete** and changes a batch
digit from **2037** to **2032** while retaining the original seal. Both edits
must be reported. The two `changed-*.png` crops are generated from the PDF's
embedded font at 144 DPI so the edited glyphs do not depend on host fonts.
It also checks that reading leaves original pixels intact.
No new OCR algorithm is needed for these framed-page fixtures.
