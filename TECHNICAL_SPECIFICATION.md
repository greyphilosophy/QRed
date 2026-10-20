# QRed Technical Specification

**Status:** Draft\
**Version:** 1.0

## 1. Overview

This document describes the current reference implementation of the QRed
document verification format.

Unlike the Business Requirements document, this specification defines
the concrete algorithms, formats, encodings, and interoperability rules
necessary to produce compatible QRed implementations.

Normative language follows RFC 2119 ("MUST", "SHOULD", "MAY").

## 2. Canonicalization

Before signing, document contents MUST be converted into deterministic
canonical text.

1.  Normalize line endings to LF (`\n`).
2.  Remove trailing whitespace from every line.
3.  Collapse consecutive blank lines into a single blank line.
4.  Remove leading blank lines.
5.  Remove trailing blank lines.

The resulting canonical text is the only representation used for digital
signatures.

## 3. Signature Algorithm

-   Ed25519
-   SHA-256 where required
-   UTF-8 canonical text

Signatures are computed over restored canonical text.

## 4. Payload Formats

### Scanner-safe hidden payload

Ordinary QR scanners see only:

    QRED.ORG

Ordinary camera apps pass only that visible URL to the browser. QRed-aware readers recover the signed payload bytes only by scanning the QR image itself.

### Plaintext and gzip

The browser supports uncompressed canonical text and gzip-compressed UTF-8 text.
Both restore exactly the signed canonical text before verification.

## 5. Encoding Strategy

Automatic mode minimizes QR count, then total encoded payload bytes, with
plaintext winning an exact tie. An explicit selection can force plaintext or
gzip. Reported savings measure payload bytes, not the number of QR codes.

## 6. Gzip Transport

Compress canonical page text once. Store the signed millisecond timestamp,
8-byte key ID, full signature, and conditional multipage context in a compact
binary `QRS3` record. Split the whole record into `QRC3` chunks only if needed.
Each chunk carries a 32-byte record digest and two-byte index/count. Issuer
names, URLs, and redundant page-hash text are omitted.

See [COMPACT_SEALS_V3.md](docs/COMPACT_SEALS_V3.md) for the complete wire format,
signed message, reassembly rules, bounds, and compatibility. Text generation
and decompression are limited to 8 MiB per page.

## 7. Chunking

Multipart records have a 40-byte header per QR. Missing chunks produce
`INCOMPLETE`; mixed sets, conflicting duplicates, and digest mismatches fail.
Single-QR records require no extra grouping identifier. Balance multiple QRs
when doing so reduces the largest grid without increasing their count.

## 8. Verification

Verification reconstructs the payload, decompresses gzip when selected, restores
canonical text, verifies the signature, and reports one of:

-   VALID
-   INVALID
-   INCOMPLETE
-   ERROR
-   UNVERIFIED (no trusted public key supplied)

## 9. Scanner

The scanner recognizes arbitrary QR codes, scanner-safe QRed payloads with hidden signed data, gzip payloads, and malformed QRed payloads. Hidden signed data is not supplied by a normal camera URL handoff; the QRed scanner must read the QR image.

Unknown QR codes remain viewable.

## 10. Key IDs

Key IDs are the first 16 lowercase hexadecimal characters of the SHA-256
digest of the Ed25519 public key bytes.

## 11. PDF Sealing

Reject non-PDFs and empty PDFs. Preserve all seals. Append overflow
pages when necessary. Page-level sealing may include page SHA-256
digests and a document Merkle root.

## 12. Deployment

Production verifier URL:

    https://qred.org/

Payload QR codes:

    visible scan result: QRED.ORG
    hidden data: signed payload bytes recoverable only from the QR image

The verifier should operate entirely within the browser after payload
acquisition.

## 13. Extensibility

Future payload versions, compression formats, and signature algorithms
may be added while preserving interoperability whenever practical.
