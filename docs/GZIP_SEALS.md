# Gzip seals

The current binary record and chunk format is documented in
[Compact seals v3](COMPACT_SEALS_V3.md). The older QRG1 carrier with URL metadata
has been removed, along with issuer-name fields and redundant page-hash text.

Canonical UTF-8 document text is compressed once per page, using the browser's
native `CompressionStream("gzip")`. Compact timestamp, key ID, signature, and
multipage context accompany that stream once per page. The complete record is
split only if necessary. QR payloads contain raw binary bytes; Base64URL is used
only for copyable links.

Automatic mode chooses the fewest QR codes, then the fewest hidden payload
bytes. Plaintext wins an exact tie. An explicit selection may force plaintext
or gzip. Without native gzip support, automatic mode falls back to plaintext.

On recovery, collect the complete set, validate its digest, reconstruct the
record, decompress when selected, and verify the full signed message. Gzip's
checksum and length detect corruption but do not authenticate a document.
Decompressed output is limited while streaming to 8 MiB per page; compressed
input is limited to 8 MiB plus 64 KiB. Malformed UTF-8 is rejected. Compression,
sealing, scanning, and verification are local and make no network requests.

`compression_savings_pct` compares actual hidden payload bytes against the
plaintext candidate, including all record and chunk headers. It is not a
percentage reduction in QR count and can be negative when gzip is forced.
