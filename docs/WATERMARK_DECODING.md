# Page-aligned watermark recovery (experimental)

The implementation in draft PR #157 supports a **single page-filling
rectangular QR** or **four balanced QR chunks arranged 2×2**, with no
internal physical quiet zones. Explicit footer mode and legacy square
watermarks remain compatible. See [quantitative acceptance requirements](WATERMARK_READABILITY_REQUIREMENTS.md).
Synthetic tests do not establish printer or phone reliability; keep the PR
draft until physical samples satisfy the release gate.

## Encoding and placement

The sealer retains standard QRed compressed payload bytes and signatures.
When a signed page fits in one QR it uses that QR, choosing the smallest
version/strongest correction supported by the payload. If it exceeds single-QR
capacity in Automatic/Watermark mode, the record is divided into exactly
four balanced chunks, including existing digest and chunk indices. The
1/4 choice applies to newly watermarked PDF pages, not to existing seals,
non-PDF documents, or explicitly selected footer layouts.

For one QR, a defined `0.03..0.97` region of the page becomes the entire
symbol; in 2×2 mode this region is divided into four adjoining rectangles.
Each module is independently scaled horizontally and vertically while the
original document remains the same physical size. A small optional
navigation QR is omitted when it would overlap the page-filling watermark.
Large opaque graphics may cause a content-avoiding square placement or footer
fallback. The stamp is considered viable only after exact-byte preflight
on a full-page PDF render and a softened/shaded simulation.

The lack of physical quiet zones and rectangular cells means these marks
are for **QRed's own verifier**, not for standard phone-camera QR apps.

## Photograph verification

The page-aligned scanner detects a rectangular white sheet against a darker
background from visible paper edges, then computes a projective mapping into
normalized page coordinates. Merely scaling a photograph by 8.5/11 cannot
remove skew or keystone distortion. A white sheet on a white background or a
cropped sheet may not be locatable; in that case QRed retains conventional
finder-based scanning.

For each expected 1/4-page region, candidate QR versions 1..40 are checked
against visible finder and timing patterns. The expected modules are sampled
at multiple points per cell in the photograph and classified as neutral-gray
watermark, paper or opaque/colored foreground. QR finder/separator/timing
structure is reconstructed where it has been covered. Uncertain **data**
modules are not invented; QR Reed–Solomon and optional erasure-aware recovery
must reconstruct any missing codewords. A virtual quiet border is added when
passing a reconstructed square matrix to patched jsQR. Successful scanning
requires recovering the complete QRed transport, and normal digest/signature
verification still makes the trust decision.

Live camera frames rotate through this path with a bounded retry budget;
the PDF page verifier also tries page geometry before ordinary QR-region
scanning. The original document, its placement coordinates, or its private
keys are not needed to interpret a printed page.

## Measurement and release

- Fixed synthetic-photo test: compare 5 black/colored foreground + skew
  photographs against the same finder-based scanner, requiring >=4/5
  complete signed recoveries and >=3 additional successes.
- Four-chunk test: all four independent no-internal-quiet-zone fragments
  recovered from one synthetic skewed photograph and cryptographically
  verified, even with partially obscured finder/foreground text.
- Negative controls: blank colored paper, missing chunks, malformed
  signatures and unsupported geometry do not yield valid signatures.
- Existing conventional QR, browser/offline, PDF and security regressions
  must remain green.
- Before merge, test actual printed pages at 150, 300 and 600 DPI. At 300
  DPI the acceptance target is >=9/10 signed-page recoveries from phone
  photographs, with representative text, logos, shadows and perspective.
  Do not claim production reliability solely from simulation.
