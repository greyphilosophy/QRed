# Signed page references

The PDF stamper runs local English OCR on each original visible page before
adding seals. It signs the OCR transcript, line boxes, and recognition confidence
separately from the full canonical text extracted from PDF objects. Neither source
replaces the other. A blank page gets an explicit signed marker; other pages can
add a grayscale vector-quantized reference and native-text positions in unused
QR capacity. No server receives images, text, positions, or the reference dictionary. Google signing still receives only
salted commitments; the existing attestation protocol signs the new binary body.

## Budget and representation

The PDF stamper limits each page to four QR codes. Required native text and the
complete OCR record determine the code count. OCR is mandatory, not an optional
thumbnail: it may require an additional QR, and the planner fails instead of
dropping or truncating it when the required record exceeds the four-code limit.
Optional evidence never increases the required record's code count. The planner
measures actual plaintext/zlib/gzip bytes and accounts for envelope and chunk
headers. It tries line boxes (8 bytes per nonblank line), finer line starts (2 bytes),
then 16×16 start cells (1 byte). It then tries visual grids up to 4,096 tiles,
reducing detail until the record fits. Without an OCR record, legacy callers can
still fall back to a text-only body. With OCR, the minimum binary evidence body is
always retained, even when no optional positions or thumbnail fit. A nonblank page
with neither native nor recognized text retains at least a one-tile visual
reference; an empty OCR transcript records that recognition found no lines. Each finished QR uses the smallest
fitting version, capped at 40, with its usual printed dimensions.

Google identity is returned after commitments have been bound to the login.
Planning therefore reserves the maximum identity size, 677 bytes, plus its
32-byte salt. If the unknown identity could put the required baseline on either side
of a QR boundary, optional evidence is omitted. This conservative choice can
leave unused space, but cannot force an extra code when the real identity arrives.

A visual reference uses a fixed dictionary of 256 four-by-four grayscale tiles:
16 flat shades and 240 oriented edges. Each tile index takes one byte before
compression. Codebook 1 is defined deterministically in `frontend/src/pageEvidence.js`
and pinned by a hash test. It is included in the app, never the seal, and must
never change under the same ID. This is ordinary nearest-vector quantization,
without a learned model or invented generative detail. Page rasterization and
area averaging occur locally; pages are processed sequentially to bound memory.

The current blank detector requires no extracted text and every pixel of the
bounded reference render to be white. This is a recorded rendering observation,
not proof that no subpixel, transparent, or otherwise invisible PDF object exists.

## Binary body format 1

Envelope flag bit 4 identifies page evidence in both QRS3 and QRS4. It is included
in the signed metadata and Google commitment, and requires the PDF flag. The
signature and Merkle leaf cover the complete **uncompressed** binary body. Existing
text-only seals remain readable. Old clients reject the new flag; update every
verifier route and saved offline copy together.

| Field | Bytes | Encoding |
| --- | ---: | --- |
| Body format | 1 | `1` |
| Body flags | 1 | Bit 0 blank; bit 1 visual; bits 2–3 line-position mode; other bits rejected |
| Visible width, height | 4 | Two big-endian unsigned 16-bit integers, rounded page points |
| Text byte length | 1–4 | Canonical unsigned base-128 varint, low group first |
| Text | Variable | Strict UTF-8, including canonical line breaks |
| Line count, if mode > 0 | 1–3 | Varint; must equal the number of nonblank text lines |
| Positions | 1, 2, or 8 per line | Mode 1: high nibble X, low nibble Y, each floor(16×normalized position). Mode 2: X,Y bytes normalized by 255. Mode 3: X,Y,width,height as u16 normalized by 65,535 |
| Visual header, if present | 3 | Codebook ID 1, tile columns, tile rows |
| Visual indices | columns × rows | One dictionary index per tile, row-major; maximum 4,096 |

Coordinates have a top-left origin in the original visible, rotated page, before
footer scaling. Mode 1 identifies a cell, mode 2 a point, and mode 3 an approximate
PDF text-line box. Blank records contain no text, positions, or visual data and
cost seven body bytes. Nonblank records with empty text require a visual reference.
Trailing bytes, unknown IDs, inconsistent counts, and oversized data are rejected.
The uncompressed body shares the existing 8 MiB bound.

## Binary body format 2: signed OCR

Format 2 retains the format 1 fields and ordering above, with these changes:

- Body format is `2`.
- Body flag bit 4 (`0x10`) marks OCR and **must** be set. Bits 0–3 retain their
  meanings; bits 5–7 are rejected. This is a body flag, separate from the envelope
  page-evidence flag.
- After all native-text positions and optional visual indices, append the OCR
  section below. There is exactly one section and no trailing data.

| OCR field | Bytes | Encoding |
| --- | ---: | --- |
| Engine ID | 1 | `1`, meaning `tesseract-eng-v1`; other IDs rejected |
| OCR line count | 1–3 | Canonical unsigned base-128 varint; zero through 65,535 |
| Line text byte length | 1–4 per line | Canonical unsigned base-128 varint |
| Line text | Variable per line | Strict UTF-8; nonblank, with no CR or LF |
| Line X, Y, width, height | 8 per line | Four big-endian unsigned 16-bit integers, normalized by 65,535 |
| Line confidence | 2 per line | Big-endian unsigned 16-bit integer, divided by 100; valid range 0–10,000 |

All per-line fields repeat in transcript order. OCR coordinates use the same
original visible, rotated-page coordinate system as native text boxes. Width and
height must be positive, X and Y nonnegative, and the entire box must lie within
the page. The encoder rounds normalized coordinates to the nearest integer grid
point, constrains positive extents to the page, and rounds confidence to 0.01.
The decoder rejects zero-size or out-of-page boxes and confidence above 100.
The current OCR adapter records the floored minimum word confidence per line
(or line confidence if word confidences are absent); confidence is an engine
observation, not a probability that the document is authentic or unchanged.

A format 2 blank record has empty native text, no layout or visual data, and zero
OCR lines, costing nine body bytes. A nonblank format 2 record needs nonblank
native text, at least one OCR line, or a visual reference. Empty OCR is therefore
valid for a graphic page, but is not a successful text match or proof of blankness.
The full uncompressed body, including OCR, remains bounded to 8 MiB. Counts,
lengths, canonical varints, strict UTF-8, supported IDs, and complete consumption
are validated before the record is used.

New decoders accept both formats 1 and 2, but reject unknown body versions.
Format 1 cannot carry the OCR flag; format 2 cannot omit it. The encoder uses
format 1 when OCR is absent and format 2 when it is present. Existing text-only
and format 1 seals remain readable; old format 1-only clients reject format 2.
Update all verifier routes and offline copies together. QRS3/QRS4 envelope
framing does not change: signatures, page hashes, Merkle leaves, and Google
commitments bind the complete uncompressed OCR-containing body just like other
page evidence. Altering OCR text, positions, confidence, or engine invalidates
the existing signature.

## Placement and verification

The default Automatic layout tries watermarks on each text page first, with a
per-page footer fallback. Explicit watermark mode uses the same behavior;
explicit footer modes skip watermark placement.
Text pages with embedded logos or pictures can use watermarks if the rendered
seals are recoverable. The original visible crop is rendered once for placement
analysis. A bounded obstruction map distinguishes broad dark regions and gray
interference from thin black strokes and their antialiased edges. Integral maps
score the data area, finder/format regions, timing strips, lower-right alignment
pattern, and quiet zone at possible positions and sizes. The score also favors
larger modules. These weights rank placements; they are not probabilities of
successful scanning or allowances for cryptographic errors.

The optimizer evaluates that map on a bounded spatial grid and refines the best
location. It does not draw, render, or scan each candidate. Multiple seals use
aligned rows/columns and a shared size, with the worst part weighted most. Page
margins, legacy square navigation-code keepouts, and the 1.5-point minimum module
size remain hard constraints. Full-page rectangles can instead accept an optional
navigation overlay after both the link and signed watermark pass clean and
simulated-print decoding; the overlay never covers original page ink.
The optimizer does not enumerate arbitrary packings or QR rotations and
cannot promise to find every usable placement. Only the chosen layout is drawn
and checked for exact payload recovery. Its geometry is retained if other pages
need to be rebuilt with footers; fallback never starts another placement search.

Image-only/blank pages use a clear footer in Automatic and watermark modes. A
failed watermark placement or rendered scan falls back on that page too. The PDF
is rebuilt from the original, so failed watermark ink is not retained. Letter pages
expand to legal size; other pages shrink to leave room. Crops and rotations are
preserved visually. Fallback changes placement only, so it does not need another
Google receipt. No QR-placement geometry or automatic photo alignment is encoded
in this format.

An intact seal can be moved into a blank area on the original page without
re-signing. Stored positions describe the original page content, not the QR's
printed location. A rendered-PDF regression test moves the stamped code to two
different blank areas on text, image-only, and blank pages, checks that no content
pixels changed, and rescans the whole page to recover the same signed reference.
This does not detect covered content: a valid signature alone cannot establish
that the seal, or any other obstruction, leaves every part of the page visible.

After signature validation, both verifier screens show the decoded reference
beside a captured or uploaded photo. A line selector highlights recorded locations.
Unverified/invalid records never appear as authenticated visual references. Displaying an already signed
reference works offline without running OCR. Image comparison is **manual**, with no
confidence percentage or automatic image-match verdict. Text comparison remains available when either signed source contains text.
The verifier preserves and identifies native PDF text and sealing-time OCR
separately. Comparison may deduplicate identical readings only when their boxes
overlap; conflicting or uncertain readings remain visible rather than silently
replacing either authenticated source. A signed OCR transcript authenticates the
machine reading, not its correctness. Fresh photo OCR is a separate observation,
not signed source evidence.

Signing a compressed image authenticates the stored approximation. It does not
prove the printed image is identical: small marks, colors, digits, faces, and
other important details can disappear, and distinct originals can produce the
same reference. These thumbnails are useful visual context, not reliable ID-photo
substitution detection. Print/camera reliability still needs physical testing.

### Located OCR baseline comparison

For native-only PDFs as well as mixed and flattened pages, the original rendering
is independently recognized before stamping. No extracted or signed wording is
provided to that recognizer. The verifier separately projects the signed OCR
boxes through the already validated page registration. Native PDF pages use
native text anchors, never the conflicting baseline wording to locate itself.
Without registration, a sequence-only match cannot establish a baseline match.
Overlapping baseline boxes, multi-column native overlaps and partial source
correspondences are marked ambiguous rather than choosing a favorable reading.

The baseline panel distinguishes exactly repeated machine readings from readings
that differ or could not be located/read. Punctuation, case, digits and word
boundaries are not corrected to match the baseline. For example, PDF text `1 of 2`
with pre-seal OCR `1of2` and fresh OCR `1of2` is shown as the same discrepancy in
both OCR readings. All native differences, missing/added text, confidence warnings,
retry alternatives and the original crops remain available. No baseline result
changes the native comparison verdict or word highlights.

This distinction is explanatory evidence, not proof that a discrepancy is harmless:
PDF text `100`, pre-seal OCR `900` and fresh OCR `900` can also occur after a real
change to `900`. That case still reports a native-text difference requiring review.
Repeated OCR does not prove pixel or semantic identity, and low confidence remains
low confidence. Older seals without OCR cannot gain this evidence retroactively.
