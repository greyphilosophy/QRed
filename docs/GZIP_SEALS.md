# Compressed seals: zlib and gzip

The current binary record and chunk format is documented in
[Compact seals v3](COMPACT_SEALS_V3.md). The older QRG1 carrier with URL metadata
has been removed, along with issuer-name fields and redundant page-hash text.

Canonical UTF-8 document text is compressed once per page, using the browser's
native `CompressionStream("deflate")` (zlib-wrapped DEFLATE). Compact timestamp, key ID, signature, and
multipage context accompany that stream once per page. The complete record is
split only if necessary. QR payloads contain raw binary bytes; Base64URL is used
only for copyable links.

Automatic mode chooses the fewest QR codes, then the fewest hidden payload
bytes. Plaintext wins an exact tie. Automatic mode compares plaintext with zlib;
if zlib compression fails, it tries gzip before falling back to plaintext.
An explicit API selection may force plaintext, zlib, or gzip. The UI remains automatic.

Zlib has a 2-byte header and 4-byte Adler-32 checksum, compared with gzip's
10-byte minimum header and 8-byte trailer. This saves **12 framing bytes per
compressed page**, regardless of how many QRs carry that page. The DEFLATE
algorithm is unchanged, and an existing flag bit identifies zlib without adding
metadata bytes. The browser chooses the compression level; its native API does
not expose a maximum-level setting. No additional compression library is needed.

On recovery, collect the complete set, validate its digest, reconstruct the
record, decompress when selected, and verify the full signed message. Zlib's
Adler-32 and gzip's CRC32/length checks detect corruption but do not authenticate
a document. Authentication still comes from the signature over the exact text.
Decompressed output is limited while streaming to 8 MiB per page; compressed
input is limited to 8 MiB plus 64 KiB. Malformed UTF-8 is rejected. Compression,
sealing, scanning, and verification are local and make no network requests.

`compression_savings_pct` compares actual hidden payload bytes against the
plaintext candidate, including all record and chunk headers. It is not a
percentage reduction in QR count and can be negative when compression is forced.

Current verifiers continue to read existing gzip and plaintext v3/v4 seals.
Older verifier builds reject the new zlib flag; deploy all verifier routes with
the stamper and refresh saved offline copies before using new zlib seals.
