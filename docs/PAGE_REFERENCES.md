# Signed page references

Blank and image-only PDF pages no longer fail text extraction. A blank page gets
an explicit signed marker; other pages without extracted text get a grayscale
vector-quantized reference. Text pages keep their full canonical text and may add
line positions and a thumbnail in unused QR capacity. No server receives images,
text, positions, or the reference dictionary. Google signing still receives only
salted commitments; the existing attestation protocol signs the new binary body.

## Budget and representation

The PDF stamper limits each page to two QR codes. Required text determines the
code count. Optional evidence never increases it. The planner measures actual
plaintext/zlib/gzip bytes, including record overhead and the 40-byte header per
chunk. It tries line boxes (8 bytes per nonblank line), finer line starts (2 bytes),
then 16×16 start cells (1 byte). It then tries visual grids up to 4,096 tiles,
reducing detail until the record fits. A full text page can retain the existing
text-only body with no evidence overhead. Each finished QR uses the smallest
fitting version, capped at 40, with its usual printed dimensions.

Google identity is returned after commitments have been bound to the login.
Planning therefore reserves the maximum identity size, 677 bytes, plus its
32-byte salt. If the unknown identity could put the baseline text on either side
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

## Placement and verification

Image/blank pages use a clear footer when watermark mode is requested. A failed
watermark placement or rendered scan falls back on that page too. The PDF is
rebuilt from the original, so failed watermark ink is not retained. Letter pages
expand to legal size; other pages shrink to leave room. Crops and rotations are
preserved visually. Fallback changes placement only, so it does not need another
Google receipt. No QR-placement geometry or automatic photo alignment is encoded
in this format.

After signature validation, both verifier screens show the decoded reference
beside a captured or uploaded photo. A line selector highlights recorded locations.
Unverified/invalid records never appear as authenticated visual references. This
view works offline without loading OCR. Image comparison is **manual**, with no
confidence percentage or automatic image-match verdict. Exact text comparison
remains available separately when the seal contains text.

Signing a compressed image authenticates the stored approximation. It does not
prove the printed image is identical: small marks, colors, digits, faces, and
other important details can disappear, and distinct originals can produce the
same reference. These thumbnails are useful visual context, not reliable ID-photo
substitution detection. Print/camera reliability still needs physical testing.
