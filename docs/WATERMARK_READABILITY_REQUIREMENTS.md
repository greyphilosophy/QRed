# QRed watermark readability — acceptance requirements

Status: **proposed, not implemented** on draft PR #157. A green conventional-QR
unit test or a successful digital-PDF crop does **not** establish any of the
readability targets below. The executable acceptance tests are intentionally
red until the corresponding behavior works end-to-end.

## Problem and baseline

Pale watermark QR modules are sometimes covered by black or colored document
text. In the existing pipeline, identifying a QR finder and pre-filtering dark
pixels both happen before the grid can be recovered. Moving the watermark
among a few square positions or allowing more QR chunks does not fix this.
QRed needs to exploit the **paper rectangle as a coordinate reference**,
occupy more usable page area, and evaluate the exposed pixels in each predicted
module. Every recovered seal must still pass the existing hidden-payload,
chunk-digest and Ed25519 verification.

The baseline is the current `scanQrImage` with ordinary finder-based recovery,
the current square `planWatermarks` placement, and the existing signed-payload
tests. Keep it available as a fallback. No scanned personal PDFs, keys or
photographs may be sent to a server.

## Requirements and objective acceptance criteria

| ID | Requirement | Automated acceptance | Physical/UX acceptance |
| --- | --- | --- | --- |
| **WM-01** | Detect a complete rectangular page independently of QR finder patterns, rectify translation/rotation/perspective and reject ambiguous/incomplete pages. No original PDF, stored stamp layout, or metadata supplied at verification. | Synthetic perspective page photo with one deliberately obscured QR finder must recover the full signed payload using the normal verifier API; unrelated images must not yield seals. | Phone photographs at off-axis angles with page edges visible. No fabricated page geometry when edges are missing. |
| **WM-02** | When a single QR suffices and outer margins are usable, prefer a **page-filling rectangle** over a square. Preserve paper dimensions and printable margins. Each module may be rectangular; its mapping must be reversible. | On otherwise empty US Letter, the single watermark uses at least **80% of the interior 18-point-margin area**; width and height differ by at least 15%. The actual rendered bottom finder must appear at the correct expected page-relative location. | Readability and normal text legibility on printout. |
| **WM-03** | Decode from predicted module positions, not just finder geometry: sample several pixels per cell, normalize local lighting and treat foreground text (black, blue, red, yellow, etc.) as missing or low-confidence evidence. Do not assume that every nonblack pixel is QR ink. | At least **four of five** fixed difficult synthetic photographs must recover identical signed data, with at least **three additional successes** over the current finder-only fallback. Partially visible modules are tested, not clean crops. | Compare black and colored text overlays on actual prints. |
| **WM-04** | When one QR cannot hold the signed record, try two and then up to four QR pieces. A 2×2 page grid should not require **four separate internal quiet zones**; it may reconstruct them in memory once the page is rectified. A fragment must carry the same signed bytes as today. | A synthetic page with four adjacent rectangular QR grids, **zero internal quiet zones**, and a partially obscured finder reconstructs **all four distinct chunks** out of order into a valid signed page. A missing chunk remains incomplete. | One camera/page-scan workflow, no manual selection of quadrant codes. |
| **WM-05** | Never count a visible `QRED.ORG` marker, a guessed bitmap, an incorrect page alignment, or an unverified chunk as a valid seal. Keep existing full-byte, digest, signature and trusted-authority checks. | Signed-payload verification after synthetic recovery; blank/foreground-only page and missing-part negative controls; existing verifier/security regression suite. | Any uncertainty must lead to a retry or clear fallback, not "verified". |
| **WM-06** | Sealing must refuse unsafe watermark placement after photo-like preflight. Use a readable footer only when practical; preserve original page dimensions when watermark passes. Navigation QR is optional. | Existing `watermarkPreflight`, `pdfWatermark`, `pdfInputIntegrity` and footer fallback tests; new rectangle and 2×2 tests. | Verify printed copy with phone. No silent false positive or inaccessible tiny fallback code. |
| **WM-07** | Preserve old conventional QR and two-part compatibility, offline operation, bounded scan workload, document text, and current signed format. | Existing `scanQrImage.test.js`, `qredVerifier.test.js`, `scanPdf.test.js`, `test_network_privacy.py`, and the complete CI suite. | Existing sealed documents must still scan. |
| **WM-08** | Quantify improvements instead of accepting geometry-only demos. Report **complete signed pages recovered / pages attempted**, compared on exactly the same fixed images and decoder budgets. | Deterministic synthetic challenge test reports old and new counts and fails if WM-03 threshold is missed. No skipped/expected-failure assertions. | Archive printer DPI (150, 300, 600), device/camera, lighting, original PDF and photographed output for each real test; require **at least 9/10** verified page attempts at 300 DPI before advertising print reliability. |

## Test traceability and release gate

- `frontend/src/qr/watermarkReadability.acceptance.test.js` explicitly tests
  **WM-01, WM-02, WM-03, WM-04, WM-05 and WM-08** against production functions.
  Tests are intentionally red first (test-driven development), not skipped and
  not satisfied by a mocked decoder or a claimed successful visible QR scan.
- Existing tests named in **WM-06 and WM-07** must also remain green.
- The new acceptance suite runs in its own GitHub Actions job; the PR must
  remain **draft** until all jobs pass. Do not change the threshold to match
  disappointing results or exempt it from CI.
- The physical test log is a separate required gate. Synthetic rendering
  cannot prove camera robustness at 150/300/600 DPI. Store only synthetic
  examples in the public repository unless actual samples are explicitly
  approved for publication.

## Implementation constraints

- Page-corner detection must be optional: retain QR finder-based scanning for
  close-ups, folded/partially visible pages and conventional seals.
- The decoder must operate on photograph pixels alone. A sealer's internal
  `watermarkLayout` may guide **sealing preflight**, but never be assumed
  available to a recipient holding only a printed sheet.
- Apply the same per-module geometry consistently in the PDF drawing path,
  printed photo sampler, and printable-margin calculations. Do not merely
  stretch a PDF image and leave its decoder square.
- If finder/alignment cells are obscured but their page-relative coordinates
  are established, they may be reconstructed from QR structural rules;
  **data** cells must come from observed photo pixels and error correction.
- Each QR may be standard version 1–40, but extended grid dimensions are not
  a standard QR and must not be presented as compatible with generic scanners.
- No implicit payload truncation, reduced signature checks, external network
  service, or plaintext-document transmission is permitted.

## Manual print challenge checklist

Use at least one dense text page, one page with colored headings and thin table
rules, and one page with a raster logo. For each page capture the sealed PDF,
print resolution, original unaltered phone JPEG, and whether all signed
chunks verify offline. Include a re-photograph with skew, uneven illumination,
and text crossing the predicted finder regions. A failure counts as a failure,
even if a perfectly cropped image or a different layout succeeds.

**Do not merge PR #157 on green CI alone without this print challenge.**
