# Page-aligned watermark recovery (experimental)

The implementation introduced in PR #157 supports a **single page-filling
rectangular QR** or **four balanced QR chunks arranged 2×2**, with no
internal physical quiet zones. Explicit footer mode and legacy square
watermarks remain compatible. See [quantitative acceptance requirements](WATERMARK_READABILITY_REQUIREMENTS.md).
Synthetic tests do not establish printer or phone reliability; broader
physical acceptance remains tracked in the requirements above.

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
Automatic and Watermark modes first try this full-page geometry whenever its
modules meet the minimum printed size. A shaded table heading, logo or broad
graphic cannot reject it based on an estimated obstruction score alone.
The stamp is considered viable only after exact-byte preflight on a full-page
PDF render and a softened/shaded simulation. If either check fails, try a
content-avoiding square layout and then a readable footer if necessary.
The failed rectangle's footprint must not exclude smaller fallback squares
inside it; overlap exclusion applies only between legacy square attempts.
Every fallback retains its existing exact-payload readability checks.

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

Photo color is measured relative to the paper: 25 central probes estimate
bounded red/blue channel gains, rejecting dark text, clipped highlights and
inconsistent or saturated colors. The edge detector and foreground mask
use these gains without relaxing the colored-ink cutoff. A warm yellow cast
must not turn the whole sheet into foreground. Gains are applied when pixels
are read, so this step does not allocate another full-resolution photograph.
PDF rasters retain their existing path.

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

Photographs are tried in all four quarter-turn orientations, including
landscape paper formats. Only the page-coordinate mapping changes; the
original pixels and the returned QR locations stay in camera coordinates.
Orientation is resolved before reconstructing any QR function patterns.
Full-matrix decoding is capped at 64 candidates for the whole page, shared
across orientations, to keep rotation support from multiplying scan work.

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

Still-photo refinement reserves up to 16 attempts for single-code layouts
and 36 for quadrant layouts across all orientation, size and scale candidates.
Finder/timing evidence ranks these candidates before local alignment fitting;
four-quadrant failures cannot consume the single-code budget. A version
observed at 97% scale can also seed the full-size single-code mapping; both
starting grids consume that same 16-region allowance. Each region attempt
keeps the established nine-sample alignment/recovery pass, with **at most
one** foreground-resistant retry (at most 104 grid fits across both layouts).
The four strongest viable single-code orientation/format hypotheses each
get their first version before the search widens to nearby versions. A small
score advantage must not let the wrong orientation consume every retry.
For versions 7–40, either visible BCH-protected version field also supports
the coarse ranking: at most three mismatched, obscured or ambiguous bits
among its 18 cells add a ranking hint. Both unreadable fields leave the
finder/timing fallback available. This prevents a slight camera roll from
promoting nearby wrong QR sizes until the refinement budget is exhausted;
the 16/36 attempt limits and normal signature verification are unchanged.
The retry compares exposed pixels in public alignment markers, requires
17 of their 25 cells, scales residual tolerance to the observed module pitch,
and continues local distortion to the outer symbol edge. Tied alignment
scores prefer the nearer starting position instead of drifting to the first
edge of a flat correlation peak.

The retry samples 25 interior pixels per data module. Where a dark stroke
is detected, it averages the five brightest observations; otherwise it keeps
the full mean, so bright edge pixels cannot erase pale modules. This prevents
dark text from biasing both the cell decision and its Gaussian local
brightness reference. Wide within-cell
brightness ranges, fully dark cells and ambiguous decisions become erasures;
they are not assumed to be dark QR ink. The original narrow sampling pass
remains first because the wider sampling can degrade clean or faint-text
prints. Neither pass relaxes QR parity, transport, digest or signature checks.

The foreground retry can combine bit-erasure and ordinary byte correction
**independently in each parity block**. If both fail, it can locate **one**
additional misread bit among the otherwise observed bits. It eliminates the
known erasure columns from the binary parity equations and requires a unique
remaining column to match the residual syndrome, with at least 16 residual
equations available. Ambiguous, rank-deficient or inconsistent systems fail
closed; the corrected block must still satisfy every QR parity equation.
This bounded extra work runs only in the still-photo foreground retry.

That retry also disables guessed, ranked byte-erasure fallback: using an
entire parity budget to guess which bytes to erase can produce a different
RS codeword and stop the grid search before the document signature rejects
it. When measured recovery fails, the caller tries another grid within its
existing budget. The established narrow pass retains its original recovery
behavior, and final digest/signature verification remains mandatory.

Live scanning delivers every recovered chunk from a page in one batch while its original
camera frame is still available, so later frames cannot become comparison
photos for earlier chunks.

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

**Integrated photo retest after PR #158 (October 31, 2026):** after
merging the compact Version-1/Q navigation-code changes from main into
PR #157, the exact current JavaScript source was packaged as a PUBLIC-code
CI artifact and executed locally against the user's same PRIVATE original.
The JPEG has EXIF orientation 6: the raw 4000×3000 raster must be rotated
to the displayed 3000×4000 orientation before passing pixels to the scanner.
With orientation applied, the current `scanPageAlignedImage({deep:true})`
returned all four Version-27 QRed fragments and the complete
`scanPdfPage` returned 4/4 in approximately 6.4 seconds. Using the demo
public key, `verifyQRedSeals` returned **VALID**, page 1 of 1, for
the exact signed text. Without applying the JPEG EXIF orientation in
the local test harness, the same image appeared undecodable. Standard
browser image-loading paths generally apply EXIF orientation before
pixel extraction; keep that behavior in any custom/native image decoder.

An older **3%-inset four-part photograph** remains undecodable by the new
deep page-aligned method in a separate local test; legacy code compatibility
has synthetic coverage, but this result does not count as another physical
pass.

**This was one successful printed-page trial, not a 9/10 field acceptance
result.** More real prints at 150, 300 and 600 DPI, darker underlying text,
different printers and varied lighting are still needed before merging.
The user's private original photographs have never been committed to the
public repository or uploaded into CI.

### Dark-text photograph follow-up

A subsequent original 12 MP photograph of the single-code, dark-text print
exposed three additional optical problems: warm paper being classified as
colored foreground, glyph pixels biasing module averages, and a fixed
seven-pixel residual cutoff rejecting useful high-resolution alignment
markers. Comparing against the delivered PDF helped diagnose these errors;
the production decoder receives only photograph pixels and public QR
structure. Source matrices and private photographs are not test fixtures.

The paper-color calibration and foreground-resistant retry above implement
those findings. Synthetic regressions require exact signed recovery under
warm/cool illumination and through dark strokes that defeat mean sampling,
plus rejection when every module is covered. The previously successful
four-code photograph still verifies in both upright and quarter-turn views.

**The dark-text photograph now verifies.** Conditional averaging and the
mixed per-block recovery above allow the production `scanPdfPage` path to
recover its complete Version-28 seal from the original 12 MP pixels. Normal
`verifyQRedSeals` reports **VALID**, page 1 of 1, with all 1,483 signed text
characters. Only after photo recovery, an independent scan of the delivered
PDF confirmed an **exact seal-byte match**. The photo decoder received no
source PDF, expected QR version, plaintext, source matrix or signing key.

Quarter-turn retests also return **VALID** at 90°, 180° and 270°. Balanced
candidate scheduling prevents the wrong orientation from exhausting the
single-code budget, and conservative foreground recovery lets the 180° view
continue past an unsupported grid candidate. These are four orientations of
one photograph, not four independent print trials. There are now two
successful printer-safe physical pages (the earlier quartet and this
dark-text single), while the broader 9/10 physical release gate remains open.

Small-angle regression checks digitally rotate the same full-resolution
dark-text photograph by **−5°, −2°, +2° and +5°**, with bilinear resampling
and every paper corner visible. All four recover the exact delivered seal
through production `scanPdfPage` and return **VALID**. The −5° view failed
before the version-field ranking hint: finder/timing sampling ranked a wrong
size first, so the bounded search never tried the correct Letter/v28 grid.
The original orientation, three quarter-turns and earlier four-code photo
still verify. Public tests cover small-angle roll on synthetic signed warped
pages and a misleading coarse grid whose readable version field selects the
right size. Digital rotations add camera-roll regression evidence, not new
physical print trials or new perspective/lighting conditions.

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
