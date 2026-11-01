# QRed watermark readability — acceptance requirements

Status: **experimental implementation under test** in draft PR #157.
A successful digital-PDF crop or synthetic camera test does **not** establish
reliability of actual printed paper. This specification remains the release
gate until synthetic acceptance and physical print-photo criteria pass.

## Problem and baseline

Pale watermark QR modules are sometimes covered by black or colored document
text. In the existing pipeline, identifying a QR finder and pre-filtering dark
pixels both happen before the grid can be recovered. Moving the watermark
among a few square positions or allowing more QR chunks does not fix this.
QRed needs to exploit the **paper rectangle as a coordinate reference**,
occupy more usable page area, and evaluate the exposed pixels in each predicted
module. Every recovered seal must still pass the existing hidden-payload,
chunk-digest and Ed25519 verification.

The baseline is the existing finder-based `scanPdfPage` pipeline with
`{pageAligned: false}`, the current square `planWatermarks` placement,
and the signed-payload tests. The enhanced scanner must support the same
`scanPdfPage` call with `{pageAligned: true}` (default after rollout). This
is a rollback/test switch, not metadata supplied by the original PDF.
Keep the legacy path as a fallback. No scanned personal PDFs, keys or
photographs may be sent to a server.

## Requirements and objective acceptance criteria

| ID | Requirement | Automated acceptance | Physical/UX acceptance |
| --- | --- | --- | --- |
| **WM-01** | Detect a complete rectangular page independently of QR finder patterns, rectify translation/rotation/perspective and reject ambiguous/incomplete pages. No original PDF, stored stamp layout, or metadata supplied at verification. | Synthetic perspective page photo with one deliberately obscured QR finder must recover the full signed payload using the normal verifier API; unrelated images must not yield seals. | Phone photographs at off-axis angles with page edges visible. No fabricated page geometry when edges are missing. |
| **WM-02** | When a single QR suffices and outer margins are usable, prefer a **page-filling rectangle** over a square. Preserve paper dimensions and printable margins. Each module may be rectangular; its mapping must be reversible. | On otherwise empty US Letter, the single watermark uses at least **80% of the 54-point (0.75-inch) printer-safe region**; width and height differ by at least 15%. The actual rendered bottom finder must appear at the correct expected page-relative location. | Readability and normal text legibility on printout. |
| **WM-03** | Decode from predicted module positions, not just finder geometry: sample several pixels per cell, normalize local lighting and treat foreground text (black, blue, red, yellow, etc.) as missing or low-confidence evidence. Do not assume that every nonblack pixel is QR ink. | At least **four of five** fixed difficult synthetic photographs must recover identical signed data, with at least **three additional successes** over the same scanner with
`pageAligned: false`. Both modes use the same page-image workload and the
same production payload verification; partially visible modules are tested,
not clean crops. | Compare black and colored text overlays on actual prints. |
| **WM-04** | When a watermark record fits one QR use one page-filling code; otherwise split it into **exactly four balanced QR pieces**, omitting two- and three-piece watermark layouts. A 2×2 page grid should not require **four separate internal quiet zones**; it may reconstruct them in memory once the page is rectified. A fragment must carry the same signed bytes as today. | A synthetic page with four adjacent rectangular QR grids, **zero internal quiet zones**, and a partially obscured finder reconstructs **all four distinct chunks** out of order into a valid signed page. A missing chunk remains incomplete. | One camera/page-scan workflow, no manual selection of quadrant codes. |
| **WM-05** | Never count a visible `QRED.ORG` marker, a guessed bitmap, an incorrect page alignment, or an unverified chunk as a valid seal. Keep existing full-byte, digest, signature and trusted-authority checks. | Signed-payload verification after synthetic recovery; blank/foreground-only page and missing-part negative controls; existing verifier/security regression suite. | Any uncertainty must lead to a retry or clear fallback, not "verified". |
| **WM-06** | Prefer a full-page rectangular watermark when its modules meet the printed-size limit; graphics estimates alone must not bypass its exact-payload PDF and photo-like preflight. If it fails, try a verified square watermark and then a readable footer. Preserve original page dimensions when a watermark passes. Navigation QR is optional. | A shaded two-page synthetic invoice must retain full-page rectangles and exact signed text. A rejected rectangle must allow a smaller verified square inside its former footprint. Existing `watermarkPreflight`, `pdfWatermark`, `pdfInputIntegrity`, opaque-page/footer and minimum-module-size tests remain required. | Verify printed copy with phone. No silent false positive or inaccessible tiny fallback code. |
| **WM-07** | Preserve old conventional QR and two-part compatibility, offline operation, bounded scan workload, document text, and current signed format. | Existing `scanQrImage.test.js`, `qredVerifier.test.js`, `scanPdf.test.js`, `test_network_privacy.py`, and the complete CI suite. | Existing sealed documents must still scan. |
| **WM-08** | Quantify improvements instead of accepting geometry-only demos. Report **complete signed pages recovered / pages attempted**, compared on exactly the same fixed images and decoder budgets. | Deterministic synthetic challenge test reports old and new counts and fails if WM-03 threshold is missed. No skipped/expected-failure assertions. | Archive printer DPI (150, 300, 600), device/camera, lighting, original PDF and photographed output for each real test; require **at least 9/10** verified page attempts at 300 DPI before advertising print reliability. |
| **WM-09** | Detect paper boundaries against lightly contrasting neutral or chromatic backgrounds, without fabricating geometry when there is no distinguishable edge. | Fixed perspective-photo examples with light-gray and light-blue tabletops must recover the signed contents; blank/indistinguishable sheets must never produce a valid seal. | Check white paper on pale desktops in natural and artificial lighting; when the edge is invisible, use the conventional QR fallback or prompt for a contrasting surface. |
| **WM-10** | Accept common 12–48 MP phone photographs without discarding the original pixel detail needed to read dense QR modules, or cloning full-size photographs repeatedly on failure. | A >12 MP synthetic photo verifies with the original photo retained; a separate mocked high-resolution legacy-fallback test enforces an <=8 MP working raster and preserves the input. | Check photo capture, responsiveness and memory usage on representative mobile devices; avoid claiming 48 MP hardware reliability from simulated photographs. |
| **WM-11** | Printing must not assume that PDF QR module coordinates map exactly to the paper edges. Correct for **2–4% content shrink/shift** and independently refine each QR quadrant for shear, rotation and local printer/camera distortion, without requiring source PDF metadata. | Synthetic 97%-scale one-/four-code tests, independent nonuniform-warp **four-Version-27** test, and signed warped single-page tests at **−5°, −2°, +2°, +5°** camera roll must recover all exact signed chunks and return `VALID`; no known QR versions or source bytes may be fed to the decoder. | The initial four full-resolution photographs failed on the original decoder. A subsequent original 12 MP photograph with 0.75-inch margins recovered **4/4** parts and returned **VALID** using private, photo-only alignment refinement. The later dark-text single-code photo now returns **VALID** with an exact delivered-seal match after conditional sampling and mixed per-block correction; all four quarter-turn views and digitally resampled **±2°/±5°** views verify. Version-field evidence fixes the previously failing −5° candidate selection. These still count as one physical trial. Broader real-world 9/10 acceptance is still open. |
| **WM-12** | Choose one margin for all full-page watermarks in the document: default to **0.75 inch (54 points)**, or use **0.5 inch (36 points)** throughout when any original rendered page has at least 4 square points of visible ink within half an inch of any edge. Preserve that choice when replanning a subset of pages, including on mixed paper sizes. Include text, images and annotations; ignore isolated raster specks. Keep the same physical profiles on Letter, Legal, A4 and A3. Never reduce below half an inch or below the existing minimum module size. Navigation QR and square fallbacks retain 54-point clearance. The verifier must recognize both profiles and earlier 3%-inset seals from pixels alone, within existing decode/refinement budgets. | Run WM-12 geometry, digital PDF rendering, 54-point and legacy compatibility tests, plus half-inch Letter/A4 single/quartet photos with 97% printer scale and rotation. Check uniform document margins when the narrow-margin page comes first or last, subset replanning, mixed paper sizes, blank/wide-margin/noise controls and the half-inch floor. Preserve footer, printer distortion, signature and minimum-module-size regressions. | Verify actual paper clearance and test **Actual size/100%** versus printer **Fit to printable area**; existing content is evidence of document layout, not proof of a printer's capabilities. Narrow-margin output still needs physical print/photo validation. |
| **WM-13** | Restore an optional navigation QR over a full-page watermark when a blank area of the original first page accommodates it. Use a white backing, an intact navigation quiet zone and a small targeting frame. Never obscure original text, graphics or annotations. Accept the overlay only when both the link and every exact signed chunk survive clean-PDF and simulated-print preflight. If it fails, retain the verified watermark without navigation. Keep legacy square quiet zones clear. | Single/quartet overlays at both margin profiles must recover exact signed payloads through the production photo scanner without layout metadata. An unreadable link must fail preflight even if the watermark still decodes. A failed overlay must not replace a working rectangle with a square or footer. Preserve original-ink and no-space regressions. | Check the navigation link with a normal phone QR reader, then verify the full page in QRed. Synthetic coverage does not establish physical printer/camera reliability. |


## Test traceability and release gate

- `frontend/src/qr/watermarkReadability.acceptance.test.js` explicitly tests
  **WM-01, WM-02, WM-03, WM-04, WM-05 and WM-08** against production functions.
  Tests were written before the geometry decoder (test-driven development), are
  never skipped and are not satisfied by a mocked decoder or visible marker.
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
