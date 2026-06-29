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

    https://qred.org/

QRed-aware readers recover the signed payload bytes hidden behind that visible bootstrap URL.

### Recipe

Current recipe: `b45` (`base45ish`).

Recipes must satisfy:

    decode(encode(text)) == text

### Legacy Compression

    (compressed pipe seals are no longer emitted or accepted)

## 5. Encoding Strategy

Automatic mode:

1.  Reject non-reversible candidates.
2.  Minimize QR count.
3.  Prefer readability.
4.  Prefer simpler encodings.

## 6. b45 Recipe

  Original     Encoded
  ------------ ---------------------
  a-z          A-Z
  A-Z          +A ... +Z
  \+           ++
  \%           %%
  digits       unchanged
  space        unchanged
  . - / : \$   unchanged
  others       UTF-8 `%HH` escapes

Malformed escapes MUST be rejected.

## 7. Chunking

Chunks include document identifier, chunk number, and total chunk count.

Mixed document IDs are invalid.

Missing chunks produce `INCOMPLETE`.

## 8. Verification

Verification reconstructs the payload, decodes recipes, restores
canonical text, verifies the signature, and reports one of:

-   VALID
-   INVALID
-   INCOMPLETE
-   ERROR

## 9. Scanner

The scanner recognizes arbitrary QR codes, scanner-safe QRed payloads with hidden signed data, recipe payloads, and malformed QRed payloads.

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

    visible scan result: https://qred.org/
    hidden data: signed payload bytes

The verifier should operate entirely within the browser after payload
acquisition.

## 13. Extensibility

Future payload versions, reversible recipes, and signature algorithms
may be added while preserving interoperability whenever practical.
