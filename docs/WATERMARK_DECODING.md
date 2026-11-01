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

For one QR, the symbol fills the interior of a **minimum 0.75-inch
(54 PDF-point) blank border on all four paper edges**; in 2×2 mode that
same printer-safe interior is divided into four adjacent rectangles. For
US Letter the QR-safe area is 7.0 × 9.5 inches. A4, A3 and US Legal use
54 points of clearance too, not a fixed percentage of page dimensions.
Each module is independently scaled horizontally and vertically while the
original document remains the same physical size. An optional small
navigation QR must also remain at least 54 points inside the page edges;
it is omitted when no safe location exists or it would overlap the
page-filling watermark. Earlier page-aligned 3%-inset seals remain
supported by the verifier's legacy geometry profile.
Large opaque graphics may cause a content-avoiding square placement or footer
fallback. The stamp is considered viable only after exact-byte preflight
on a full-page PDF render and a softened/shaded simulation.

The lack of physical quiet zones and rectangular cells means these marks
are for **QRed's own verifier**, not for standard phone-camera QR apps.

## Photograph verification

The page-aligned scanner detects the rectangular sheet from visible paper
edges (including modest brightness or color separation from a pale tabletop),
then computes a projective mapping into normalized page coordinates. Merely
scaling a photograph by 8.5/11 cannot remove skew or keystone distortion.
There is no reliable optical way to infer a border that has no contrast with
the background: white paper against indistinguishable white surroundings,
or a heavily cropped sheet, may be unlocatable. In those cases QRed retains
conventional finder-based scanning; placing the document on a contrasting
surface makes page-aligned scanning easier.

High-resolution photos are not blindly rejected at 12 megapixels. The page
edge detector instead runs on a bounded (~1.5 MP) preview and maps the
detected corners **back to the original full-resolution pixels**, which are
still used to estimate the QR modules. If that scan fails, legacy QR-region
discovery runs on a separately bounded (~8 MP) copy so it never repeatedly
clones a complete 12–48 MP original photograph.

A photographed sheet has no trustworthy embedded paper-size metadata.
The verifier ranks plausible US Letter, US Legal, A4, A3 and Tabloid page
dimensions from its apparent aspect ratio, then checks each candidate's
**physical 54-point inset** against finder/timing evidence and recovered
signatures. Legacy 3%-inset page-aligned marks are also attempted. A rendered
PDF has its actual page bounds available; a printed photograph never does.

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

### Printed-paper findings, October 31, 2026

The first four original 12-megapixel Galaxy Z Flip6 photographs recovered
0/4, 0/4, 0/1 and 0/1 signed fragments with the older page-coordinate
decoder. The printed PDF content was about 2–4% smaller than its nominal
sheet-relative coordinates, with local shear/skew. Page-corner perspective
correction alone was insufficient.

A fifth **original 4000×3000 JPEG** of a newly printed US Letter document
with **0.75-inch margins and four Version 27 QR symbols** provided an
important physical acceptance milestone. The page-only decoder initially
recovered zero fragments, but independent optical calibration using the
QR codes' distributed *5×5 alignment patterns*, robust affine fitting,
bilinear residual interpolation, nine-sample module brightness classification
and version-information BCH checks recovered **all four distinct exact
signed QRed fragments**. The ordinary QRed verifier returned **VALID**
for the complete signed page (page 1 of 1) using its demo public key.
Neither expected source PDF bytes nor its signing keys were provided to
the photo decoder.

The resulting source-free algorithm is implemented in
`qrAlignmentRefinement.js` and `pageAlignedRecovery.js`, with bounded
`deep:true` fallback for uploaded still photographs/manual captures; live
camera frames continue using a lower-cost pass. Synthetic acceptance now
requires recovery of all four signed Version 27 fragments on an independently
warped page, without a saved placement or known version.

**This is one successful printed-page trial, not a 9/10 field acceptance
result.** More real prints at 150, 300 and 600 DPI, darker underlying text,
different printers and varied lighting are still needed before merging.
The user's private original photographs have never been committed to the
public repository or uploaded into CI.

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
