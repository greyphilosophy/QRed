# Hex-spoke print/camera experiment results

2026-11-03 UTC. **Not ready for a physical acceptance print.**

The twelve-spoke carrier recovered the exact signed payload on both reference documents, but did not pass the full preset sweep. The independently run OCR checks also reported differences on unchanged pages, including unwatermarked controls. No full QRed browser workflow pass is claimed. No production behavior or acceptance threshold was changed.

## Frozen optical evaluation

Two synthetic documents, all nine unchanged simulator presets, seed 911. Rendering/reader settings were fixed after development with seed 168. A PASS requires recovery of the exact expected transport, normal QRed error correction, and valid digest/Ed25519 authentication. It does not mean the visible words passed OCR.

The rectangular columns use the same experimental registration and sampler infrastructure as the hex columns. They are controlled carrier comparisons, not results from the native production scanner. All have the same payload, page area, marker dimensions and 85% gray ink shade; total ink coverage differs.

| Simulator preset | Plain rectangles | Plain 12 spokes | Dense rectangles | Dense 12 spokes |
| --- | --- | --- | --- | --- |
| reference | PASS | PASS | FAIL | PASS |
| clustered | PASS | PASS | FAIL | PASS |
| preview | PASS | PASS | PASS | FAIL |
| still | FAIL | FAIL | FAIL | FAIL |
| pattern-shadow | PASS | PASS | FAIL | PASS |
| pale-desk | PASS | PASS | FAIL | PASS |
| low-dpi | FAIL | FAIL | FAIL | FAIL |
| blur-compression | PASS | FAIL | FAIL | FAIL |
| observed-scene | FAIL | FAIL | FAIL | PASS |

Twelve spokes: **10/18** optical cases passed. Controlled rectangles: **7/18**. One seed per preset and only two payloads are insufficient to establish a general advantage.

## What the neighbor evidence contributed

Reference development run, seed 168, 85% gray:

| Carrier | Plain exact payload | Dense exact payload |
| --- | --- | --- |
| rect | PASS | FAIL |
| dots | PASS | FAIL |
| hex6 | PASS | FAIL |
| hex12 | PASS | PASS |

On the same twelve-spoke photo, enabling neighbor measurements changed the pre-ECC results:

| Document | Center-only wrong bits | With neighbor evidence | Center-only payload | With neighbors |
| --- | ---: | ---: | --- | --- |
| plain | 44 | 11 | PASS | PASS |
| dense | 643 | 83 | FAIL | PASS |

These wrong-bit totals include guessed values at erased positions. They are not undetected errors after authentication. The dense held-out reference and clustered cases also passed only after neighbor evidence was used.

## Failure limits

* Dense live-preview resolution and blur/compression still fail. Twelve thin directions are not automatically easier to resolve than filled modules.
* The plain blur/compression case fails marker-geometry consistency. Some other misses reject low separability or exhaust the erasure budget.
* High-resolution and low-printer-DPI cases produce many erasures. A likely reader limitation is confusing resolved halftone dots with document ink; this diagnosis needs a separate ablation.
* A 94% gray development trial still decoded the plain page but lost the dense-page payload. It did not eliminate the existing OCR differences.

## Independent OCR and production baseline

OCR used the existing QRed browser reader and comparison, with no expected text supplied to recognition. Difference groups are the existing comparison's output, not a normalized accuracy score. All listed raw-camera OCR checks failed the unchanged-text criterion.

| Image | Gray / phase | Difference groups | OCR status |
| --- | --- | ---: | --- |
| plain-hex12-reference-168.jpg | reference_raw | 5 | differences |
| plain-rect-reference-168.jpg | reference_raw | 5 | differences |
| plain-hex12-reference-168.jpg | faint_raw | 4 | differences |
| plain-rect-reference-168.jpg | faint_raw | 4 | differences |
| dense-hex12-reference-168.jpg | faint_raw | 28 | differences |
| dense-rect-reference-168.jpg | faint_raw | 27 | differences |
| plain-source-only-reference-168.jpg | controls_raw | 3 | differences |
| plain-tags-only-reference-168.jpg | controls_raw | 4 | differences |
| dense-source-only-reference-168.jpg | controls_raw | 24 | differences |
| dense-tags-only-reference-168.jpg | controls_raw | 27 | differences |
| plain-production-reference-911.jpg | production_reference | 4 | differences |
| dense-production-reference-911.jpg | production_reference | 33 | differences |

Rectifying the two reference carriers before OCR was tested separately and also failed; the detailed differences are in `evidence.json`. The unwatermarked controls already have OCR errors, so these results do not establish that hexes caused the whole OCR problem.

For the actual production PDFs (without experimental tags), the unchanged production reader recovered 1 of 2 exact reference payloads at seed 911. The production dense invoice authenticated; the plain page did not decode within the requested search. Both failed OCR. This baseline remains separate from the controlled rectangle experiment.

## Validation and reproducibility

* Three geometry invariants passed: correct two distance shells/reciprocity, contained strokes/margins, unique public registration IDs.
* Nine existing simulator model tests passed.
* Thirty-four existing QR construction, erasure recovery and verifier tests passed.
* Four source-only/registration-only optical negatives were rejected before payload recovery; none authenticated.
* The 36-case optical acceptance command exited **1**, preserving the failures. The measured pass/fail table is not an expected-failure waiver.

`evidence.json` records the measurements, OCR differences, per-photo simulator manifests, hashes, profiles, seeds, and runtime versions. The normal simulator is unmodified. The photos and fixtures use only public synthetic material. See [README.md](README.md) to reproduce the experiment. No real printer or phone has been validated, and the hex reader is not installed in the production browser app.
