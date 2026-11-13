# Compact seals v3

Version 3 removes issuer names and URL-formatted metadata from printed seals.
It keeps a signed timestamp with millisecond precision, an 8-byte key ID, the
full 64-byte Ed25519 signature, and the canonical document text. Multipage PDFs
also carry their signed page position/count and full document Merkle root.

The timestamp comes from the signing device's clock. It helps distinguish
iterations; it is not an independently certified time. Key IDs help select a
public key but do not establish which authority owns it. Recipients still need
a trusted public key. A public key directory/table is future work; no issuer
name is stored in a seal or requested in the stamping form.

## Single-QR record

The seal payload is a binary record. Integers are unsigned, big endian.

| Field | Bytes | Meaning |
| --- | ---: | --- |
| Magic/version | 4 | ASCII `QRS3`; signature algorithm is Ed25519 |
| Flags | 1 | Bit 0: gzip; bit 1: PDF; bit 2: multipage PDF; bit 3: zlib; bit 4: binary page evidence; other bits rejected; gzip and zlib are mutually exclusive |
| Timestamp | 8 | Unix milliseconds; must be representable as a JavaScript date |
| Key ID | 8 | First eight bytes of SHA-256 of the raw 32-byte public key |
| Page index, if multipage | 2 | Zero based |
| Page count, if multipage | 2 | 2–65,535; index must be below count |
| Document root, if multipage | 32 | Full SHA-256 Merkle root |
| Signature | 64 | Raw Ed25519 bytes |
| Content | Remaining | UTF-8 text or binary page evidence, optionally one complete zlib/gzip stream |

A text-only or single-page PDF record has **85 bytes** before its content.
Multipage context adds **36 bytes**, for 121 bytes per page record. Single-page
PDFs imply index zero/count one and derive the document root from the uncompressed
page body. Page hashes are computed from that body instead of stored. Human-readable
integrity labels are never prepended to the document content.

PDF extraction, text canonicalization, and form checks are unchanged. When bit 4
is set, the uncompressed content is a [binary page body](PAGE_REFERENCES.md). The
signature and page hash cover all of its bytes. Bit 4 is signed and requires the
PDF flag. The PDF Merkle construction hashes uncompressed page bodies (canonical
text for a legacy text-only page) as leaves and hashes concatenated lowercase
hexadecimal child hashes at each parent; an unmatched final child is duplicated. Page count and index are signed
explicitly, including for identical pages. A root is a signed document
fingerprint; scanning one page does not independently recompute the entire
multipage document or establish a Merkle inclusion proof.

## Signed message

Ed25519 signs this unambiguous byte sequence:

1. UTF-8 `QRed signed document v3` followed by one zero byte.
2. The record's flags **with bits 0 and 3 cleared**, timestamp, key ID, and conditional
   multipage fields, in exactly the layout above (17 or 53 bytes).
3. The complete uncompressed content: canonical UTF-8 text, or the binary page
   body when bit 4 is set.

The domain fixes the protocol version and algorithm. Compression and chunk
boundaries may change without changing the signature. The timestamp, key ID,
PDF context, page position/count, document root, and recovered text cannot.
The signature and hashes are stored as bytes, without Base64/hex expansion.

## Appended seal sheets

On a seal sheet the first byte of the ordinary QR message is lowercase ASCII
`q`. The four carrier tags are `qRS3`, `qRC3`, `qRS4`, and `qRC4`. Restore
uppercase `Q` before interpreting the original record or comparing duplicate
chunks. The placement hint occupies no additional bytes and conveys no trust.
All digest, signature, and page membership checks use the ordinary records.
Earlier readers need an update to recognize these carriers.

The sheet photo supplies seals only. For a physical copy, the recipient selects
the authenticated page number and photographs that original. In a combined
PDF the reader uses the original page index to obtain the comparison image.

## Multiple QRs for one page

A footer or watermark carries up to four codes on an original page. Explicit
seal-sheet layouts can paginate additional chunks within the transport limits.
The page text, recorded OCR misreadings and the line boxes they require determine
the number of codes. Optional visual detail uses the remaining capacity.

First construct the complete record above. If it exceeds the maximum
QR byte payload (2,953 bytes at version 40-L), split that record into raw byte chunks.
Every chunk has this header:

| Field | Bytes | Meaning |
| --- | ---: | --- |
| Magic/version | 4 | ASCII `QRC3` |
| Set digest | 32 | SHA-256 of the complete encoded record |
| Chunk index | 2 | Zero based |
| Chunk count | 2 | 2–4,096; index must be below count |
| Data | Remaining | Nonempty slice of the record |

The header is **40 bytes per QR**. Page metadata and the signature appear only
once in the reassembled record, not in every QR. The digest distinguishes
iterations, keys, page positions, and encoding choices. Missing chunks return
`INCOMPLETE`; mixed sets/counts and conflicting duplicates are rejected. Scan
order is irrelevant; identical repeated scans are harmless. Check the digest
before interpreting or decompressing the reconstructed record, then verify its
signature with the selected trusted key. A matching set digest alone is never
authentication.

Single-QR records need no stored grouping ID. Their displayed/collection ID is
derived from the existing signature. Multipart IDs come from the set digest.
Neither is an additional signed document-ID field.

## QR size, recovery, and copyable strings

Keep the minimum QR count. With multiple QRs, balance the record bytes if all
codes can fit below version 40; otherwise retain the greedy split and its smaller
last code. Each code chooses its smallest fitting version, then the strongest
error correction fitting that grid. Printed dimensions remain unchanged.
The QR mask is selected using the complete message data and error-correction
codewords. Image downscaling uses an antialiasing filter so printed modules do
not disappear through point sampling.

Each payload QR uses one ordinary byte segment containing the binary record or
chunk, without a URL or Base64 expansion. Its header is 12 bits for versions 1–9
and 20 bits for versions 10–40. A zero terminator, byte alignment and alternating
`0xEC`/`0x11` padding follow the message as usual. No data is stored after the
terminator. Maximum message capacity is **2,953 bytes at version 40-L**, eight
more than the retired padding format. At that version, M/Q/H capacities are
2,331/1,663/1,273 bytes. Chunk headers count toward those limits.

The verifier reads the decoder's standard `binaryData` message. Erasure recovery
parses the byte-mode header and declared length from corrected codewords; it
never searches beyond a terminator. Rectangular page watermarks retain the same
layout and optical recovery. Navigation uses a separate `https://qred.org/` QR on the first page: required in
its footer when using footer seals, or placed on its watermark when it fits.
Every sealed page retains the “Verify at QRED.ORG” text.

Copyable strings use `https://qred.org/#QRED3:<Base64URL-of-binary-payload>`.
A custom bootstrap URL changes only the copyable link. Image recovery returns
the canonical default link; its binary payload is identical. Bare
`QRED3:<Base64URL>` strings also work. Base64URL must be canonical and unpadded.

## Bounds, compression, and compatibility

Canonical text is limited to 8 MiB per page. Compressed input is limited to that
size plus 64 KiB. Enforce decompression output bounds while streaming, validate
the zlib Adler-32 or gzip CRC32/length, and reject malformed UTF-8, framing, flags, or indices.
The largest full record is the compressed limit plus its 121-byte header.
Automatic encoding compares plaintext and zlib by QR count, then actual binary
payload bytes; plaintext wins a tie. Zlib adds 6 container bytes once per page,
12 fewer than gzip's 18 bytes. The native browser compressor chooses the level.
If zlib compression fails, automatic encoding tries gzip; if neither is available,
it uses plaintext. Explicit compression requests fail clearly when unavailable.
Processing remains local and makes no network requests.

For the original text-only invoice example (before optional evidence), gzip
produced a 403-byte record (85 record-header bytes + 318 compressed bytes).
Using the same DEFLATE body with zlib reduces the record to 391 bytes. QR headers,
terminator, padding and error correction are additional. Byte savings need not
reduce the QR version.

Deploy the stamper and every verifier route together, and refresh offline copies.
QR images from the retired post-terminator padding format are intentionally
unsupported and must be re-sealed. The signed v3/v4 records themselves have not
changed; existing copyable strings can still be verified or re-encoded in ordinary
byte-mode QRs. Current verifiers still
accept gzip/plaintext v3 and v4 records; older verifier builds reject the zlib
flag and must be refreshed, including saved offline copies. The page-evidence
flag similarly requires refreshing all verifier routes and offline copies; older
clients reject it rather than treating binary image data as text. Older QRED1/QRG1 seals
are intentionally unsupported and must be re-sealed; no legacy verification
path remains. Unknown QR content can still be displayed without being verified.

## Verification coverage

Tests include independent Node Ed25519 verification, timestamp/key/context/text
tampering, replacement zlib/gzip streams, malformed headers, Unicode/BOM recovery,
missing/duplicate/mixed chunks, forged grouping digests, identical PDF pages,
capacity boundaries, saved-PDF recovery at 200/300 dpi, camera damage correction,
all verifier routes, and workflows with network access blocked.
