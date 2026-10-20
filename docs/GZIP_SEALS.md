# Gzip seal transport

The browser stamper supports `automatic`, `plaintext`, and `gzip`. Automatic
selection minimizes QR count, then the total number of hidden payload bytes.
Plaintext wins an exact tie. A failed size candidate does not prevent selection
of a successful alternative. If the browser lacks `CompressionStream`, automatic
mode uses plaintext; explicitly requesting gzip reports an error.

## Signing and compression

The version 2 Ed25519 signature still covers the canonical text and its identity
metadata as specified in [SIGNED_SEALS_V2.md](SIGNED_SEALS_V2.md). Gzip is a
transport choice: the verifier must restore the exact UTF-8 text before checking
the signature. This does not change canonicalization or authenticate PDF images.

Each PDF page's complete canonical text, including its integrity header, is
compressed once with `CompressionStream("gzip")`. The resulting single gzip
member is split into byte chunks that fit the QR carrier. Chunks may split at
any byte boundary; they are not independent gzip members.

## Copyable seal strings

The existing `QRED1?` URL representation carries identity fields, `i`, `n`,
`rc=gzip`, and `txt=<Base64URL chunk>`. Each chunk is encoded separately without
padding. Only chunk 0 contains `sig`. Base64URL exists for manual entry and
copying; it is not stored as text inside a compressed QR.

## Binary carrier

Ordinary scanners see `QRED.ORG`. The existing post-terminator two-byte length
prefix frames the hidden payload. For gzip, that payload has this layout:

| Field | Length | Representation |
| --- | --- | --- |
| Magic | 4 bytes | ASCII `QRG1` |
| Metadata length | 2 bytes | Unsigned, big endian |
| Metadata | Declared length | UTF-8 seal URL with its `txt` field removed |
| Chunk | Remaining bytes | Raw gzip-stream bytes |

Metadata must contain exactly one `rc=gzip` and no `txt`. Duplicate metadata
fields, malformed UTF-8, truncated framing, and empty chunk bodies are rejected.
The scanner reconstructs the copyable URL by encoding the raw chunk as
Base64URL and appending `txt`. Plaintext payloads remain UTF-8 seal URLs.

Capacity checks use the real binary representation, including metadata and
framing. At QR version 40-L the outer carrier permits 2,945 hidden bytes. The
gzip header and metadata consume part of that budget. Normal QR error correction
protects the complete stream, including the binary payload.

Automatic QR sizing chooses the lowest version that fits, then the strongest
error correction available at that version (H, Q, M, then L). Each chunk is
sized independently using its actual carrier bytes, so a short final chunk can
use a smaller grid. The PDF layout keeps its printed dimensions independent
of QR version. Explicit error-correction settings still take precedence over
automatic sizing.

## Reassembly and validation

The verifier requires consistent document ID, version, algorithm, issuer, key
ID, timestamp, encoding, and total count. Indices must be integers in `[0,n)`;
`n` must be between 1 and 4,096. Conflicting duplicates and mixed metadata are
rejected. Missing chunks return `INCOMPLETE` before decompression.

Decode each chunk's Base64URL independently, concatenate the bytes in index
order, then use `DecompressionStream("gzip")`. A checksum failure, truncated
stream, invalid UTF-8 output, or unsupported encoding returns `ERROR`. Valid gzip
containing altered text still fails the digital signature. Signature checking
uses a trusted public key; gzip itself provides no authenticity or secrecy.

Generation and decompression are limited to 8 MiB of canonical UTF-8 text per
seal group. Compressed input is limited to that size plus 64 KiB. The reader
counts decompressed output as it arrives and cancels if the limit is exceeded,
without trusting the gzip length trailer.

`compression_savings_pct` compares actual hidden payload bytes with the
plaintext candidate, including repeated metadata and gzip framing. It is not a
percentage reduction in QR count. It can be negative for explicitly forced
gzip, and is null when the plaintext candidate cannot be represented.

## Deployment

Deploy the stamper and all verifier entry points together. Older verifiers do
not understand the binary gzip carrier. Text-recipe and Brotli decoding have
been removed; no compatibility with those encodings is promised. Compression
uses native browser APIs and makes no network requests.
