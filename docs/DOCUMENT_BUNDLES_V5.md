# Appended document bundles (QRED5)

An appended sheet carries pieces of one compressed document bundle, with at most
six QR symbols per sheet. Fewer symbols use the available space for larger QR
squares. Only the sheet is labeled (`Seal sheet 1 of N`); piece indexes stay
inside the codes. Neighboring symbols share one four-module quiet zone, sized
for the larger physical modules. The bottom page margin supplies the last row's
quiet zone; there is no footer. Every sheet retains the small navigation QR and the
three printed steps: open QRed, scan the large seals, photograph the originals.

The bundle contains every original page, including pages with readable watermarks
in the hybrid layout. All its pieces must be collected, in any order, before the
bundle exposes original pages for verification. The current reader also accepts
existing QRS3/QRC3, QRS4/QRC4 and lowercase sheet carriers. Refresh saved offline
readers before scanning a new QRED5 appendix. The original watermark format and
provider attestation protocol do not change.

## Binary QR transport

A QR contains a standard binary byte segment. The navigation URL is separate.
The copy/paste form is `https://qred.org/#QRED5:<unpadded base64url>`.
All integers below are unsigned, big endian.

| Field | Bytes | Meaning |
| --- | ---: | --- |
| Magic | 4 | ASCII `QRD5` |
| Bundle digest | 32 | SHA-256 of the complete encoded packet |
| Piece index | 2 | Zero based, below piece count |
| Piece count | 2 | 1–4,096 |
| Data | Remaining | Nonempty slice of the encoded packet |

Each QR is at most 2,953 bytes, including the 40-byte header. Pieces are balanced
across the minimum required code count. A one-code bundle retains the same
header. It is always an appended-sheet carrier; its photograph is not an image
of an original page.

## Encoded packet

The first byte selects the body encoding: 0 = plaintext, 1 = zlib, 2 = gzip.
The remaining bytes encode the complete bundle body. The writer tries joint
zlib compression, with the existing plaintext/gzip fallback policy. It first
decompresses the individual page bodies; recompressing separate deflate streams
would lose most cross-page savings.

The decoded body begins with a two-byte original page count. Each entry is a
four-byte record length followed by a complete QRS3 or QRS4 envelope, using
plaintext body encoding. Metadata, identity, signature, page evidence and body
bytes are retained; only compression flags change. Existing page signatures bind
the original metadata and uncompressed body, independently of compression.

The decoded bundle, including lengths and envelopes, is limited to 8 MiB. The
encoded transport uses the existing compressed/envelope byte bound. Unknown
encodings, nested compression, oversized/truncated records, trailing bytes,
missing pages and repeated positions are rejected. Embedded entries must contain
all page positions of one document root, signer, identity, timestamp, format and
page count. The 8 MiB aggregate bound can reject a document that would fit when
sealing its pages separately; the writer reports this explicitly.

## Verification and page photos

The outer digest checks assembly, not authorship. After all pieces arrive, the
reader checks the digest, bounded decompression and framing, then verifies every
embedded page signature through the existing local-key or trusted-authority path.
A correctly recomputed outer digest cannot make an altered page authenticate.
Missing keys remain unverified; a bad page signature remains invalid.

The collection deduplicates the same signed page found both in a watermark and
a bundle. Photo associations retain transport aliases so either scan route can
supply the page image, preferring the newest capture. PDF input uses each embedded
original-page index to rasterize the original; it never compares a seal sheet as
if it were an original. Photos taken separately are still selected by the
verified original page number.

The camera offers Whole page (page quality gate and high-resolution still) and
Individual seal (ordinary QR decoding without requiring page corners). Both feed
the same verification session, including duplicate, missing-piece and signature
checks. Individual mode is session-only and also works with older printed seals.
