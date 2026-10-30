# Compact seals v3

Version 3 removes issuer names and URL-formatted metadata from printed seals.
It keeps a signed timestamp with millisecond precision, an 8-byte key ID, the
full 64-byte Ed25519 signature, and the canonical document text. Multipage PDFs
also carry their signed page position/count and 128-bit truncated document Merkle root.

The timestamp comes from the signing device's clock. It helps distinguish
iterations; it is not an independently certified time. Key IDs help select a
public key but do not establish which authority owns it. Recipients still need
a trusted public key. A public key directory/table is future work; no issuer
name is stored in a seal or requested in the stamping form.

## Single-QR record

The hidden payload is a binary record. Integers are unsigned, big endian.

| Field | Bytes | Meaning |
| --- | ---: | --- |
| Magic/version | 4 | ASCII `QRS3`; signature algorithm is Ed25519 |
| Flags | 1 | Bit 0: gzip; bit 1: PDF; bit 2: multipage PDF; bit 3: zlib; bit 4: binary page evidence; other bits rejected; gzip and zlib are mutually exclusive |
| Timestamp | 6 | Unsigned 48-bit Unix milliseconds; retains 1 ms precision through ~year 10889 |
| Key ID | 8 | First eight bytes of SHA-256 of the raw 32-byte public key |
| Page index, if multipage | 2 | Zero based |
| Page count, if multipage | 2 | 2–65,535; index must be below count |
| Document root, if multipage | 16 | First 128 bits of SHA-256 Merkle root |
| Signature | 64 | Raw Ed25519 bytes |
| Content | Remaining | UTF-8 text or binary page evidence, optionally one complete zlib/gzip stream |

A text-only or single-page PDF record has **83 bytes** before its content.
Multipage context adds **20 bytes**, for 103 bytes per page record. Single-page
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
   multipage fields, in exactly the layout above (15 or 35 bytes).
3. The complete uncompressed content: canonical UTF-8 text, or the binary page
   body when bit 4 is set.

The domain fixes the protocol version and algorithm. Compression and chunk
boundaries may change without changing the signature. The timestamp, key ID,
PDF context, page position/count, document root, and recovered text cannot.
The signature and hashes are stored as bytes, without Base64/hex expansion.

## Multiple QRs for one page

The PDF stamper permits at most two QR codes per page. Optional evidence uses
spare capacity within the count needed for text. The decoder still accepts older
records with more chunks.

First construct the complete record above. If it exceeds the maximum hidden
QR payload (2,945 bytes at version 40-L), split that record into raw byte chunks.
Every chunk has this header:

| Field | Bytes | Meaning |
| --- | ---: | --- |
| Magic/version | 4 | ASCII `QRC3` |
| Set digest | 16 | First 128 bits of SHA-256 of the complete encoded record |
| Chunk index | 2 | Zero based |
| Chunk count | 2 | 2–4,096; index must be below count |
| Data | Remaining | Nonempty slice of the record |

The header is **24 bytes per QR**. Page metadata and the signature appear only
once in the reassembled record, not in every QR. The truncated digest distinguishes
iterations, keys, page positions, and encoding choices; the complete
record still requires an authentic 64-byte Ed25519 signature. Missing chunks return
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
The QR mask is selected using the complete hidden data and error-correction
codewords. Image downscaling uses an antialiasing filter so printed modules do
not disappear through point sampling.

Ordinary readers still see `QRED.ORG`. Its terminator/alignment and the two-byte
hidden-payload length use 10–11 data bytes per QR, outside the record/chunk sizes
above. Ordinary QR error correction, padding, patterns, and quiet zones are
additional. No URL is embedded in the hidden record.

Copyable strings use `https://qred.org/#QRED3:<Base64URL-of-binary-payload>`.
A custom bootstrap URL changes only the copyable link. Image recovery returns
the canonical default link; its binary payload is identical. Bare
`QRED3:<Base64URL>` strings also work. Base64URL must be canonical and unpadded.

## Bounds, compression, and compatibility

Canonical text is limited to 8 MiB per page. Compressed input is limited to that
size plus 64 KiB. Enforce decompression output bounds while streaming, validate
the zlib Adler-32 or gzip CRC32/length, and reject malformed UTF-8, framing, flags, or indices.
The largest full record is the compressed limit plus its 103-byte header.
Automatic encoding compares plaintext and zlib by QR count, then actual hidden
payload bytes; plaintext wins a tie. Zlib adds 6 container bytes once per page,
12 fewer than gzip's 18 bytes. The native browser compressor chooses the level.
If zlib compression fails, automatic encoding tries gzip; if neither is available,
it uses plaintext. Explicit compression requests fail clearly when unavailable.
Processing remains local and makes no network requests.

For the original text-only gzip sample invoice (before optional evidence), compressed text is 318 bytes, giving a 401-byte hidden
record (83 + 318). With QRed framing, non-text overhead is 111 bytes: 83 record
bytes + 18 gzip bytes + 10 QRed framing bytes. It fits QR version 13 at the same
2.75-inch printed footprint. The prior format used 418 non-text bytes and
version 18 for this fixture. With the same DEFLATE body, zlib reduces the hidden
record to 389 bytes and non-text overhead to 99 bytes. A 12-byte saving does not
necessarily reduce the QR version. Stored gzip image fixtures remain readable.

Deploy the stamper and every verifier route together. Current verifiers still
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
