# QRed Specification

Version: 0.2

# Overview

QRed is a document sealing and verification standard that embeds a signed representation of a document within one or more machine-readable seals printed on the document itself.

A QRed document consists of:

- One bootstrap seal
- One or more payload seals
- A signed document payload

The bootstrap seal directs the recipient to a verification application.

The payload seals contain the signed document data required to reconstruct and verify the certified contents.

---

# Document Generation Workflow

1. Source document is provided.
2. A canonical text representation is produced.
3. The canonical text is digitally signed using Ed25519.
4. In automatic mode, implementations SHALL evaluate all reversible supported payload candidates, currently plaintext fragment URLs, reversible recipe payloads such as `b45`, and legacy compressed `QRED1|...` payloads.
5. Only reversible candidates are selectable.
6. Automatic mode SHALL choose the candidate with the smallest QR count.
7. QR-count ties SHALL prefer plaintext, then recipe encodings, then compressed legacy encoding.
8. Explicit encoding strategies MAY request `plaintext`, `b45`, or legacy compression aliases supported by the implementation.
9. The chosen payload form is divided into chunks and encoded into machine-readable seals.
10. The payload seals are placed on the document.

---

# Verification Workflow

1. User scans bootstrap seal.
2. Verification application loads.
3. Verification application scans payload seals.
4. Payload is reconstructed from all chunks.
5. Payload integrity is validated (all chunks present).
6. If the payload is compressed, it is decompressed.
7. Digital signature is verified using the issuer's public key.
8. Certified contents are displayed.
9. Verification result is reported.

---

# Canonical Representation

Implementations SHALL produce a deterministic text representation of the certified document contents.

The canonical representation MUST:

- Preserve certified text content.
- Produce identical output for identical document contents.
- Exclude non-essential formatting.

The reference implementation:

- Splits text on `\n` line endings.
- Strips trailing whitespace from each line.
- Collapses consecutive blank lines to a single blank line.
- Strips leading and trailing empty lines.

Future versions may standardize canonicalization.

---

# Payload Structure

A QRed payload SHALL contain:

- Format version
- Issuer identifier
- Key ID (derived from the issuer's public key)
- Document identifier
- Creation timestamp
- Canonical document text
- Signature metadata
- Digital signature

The reference implementation encodes the payload as a JSON object:

```json
{
  "version": "1",
  "issuer": "Example Authority",
  "key_id": "a1b2c3d4e5f6a1b2",
  "document_id": "DOC-ABC123DEF456",
  "timestamp": "2026-06-18T00:00:00+00:00",
  "content": "...",
  "signature": "...",
  "algorithm": "Ed25519"
}
```

The reference implementation stores the signed payload as JSON with sorted keys and compact separators, then automatic mode evaluates all reversible supported candidates, currently:

- plaintext `QRED1?...` fragment URLs that carry the canonical text directly,
- reversible recipe payloads such as `b45`, and
- legacy compressed `QRED1|...` seal formats that gzip-compress and base64-encode the payload.

Only reversible candidates are selectable. Automatic mode selects the candidate with the smallest QR count. Ties prefer plaintext, then recipe encodings, then compressed legacy encoding. Explicit strategies may request `plaintext`, `b45`, or supported legacy compression aliases such as `legacy_compression`.

## Reversible Recipe Fragment Payloads

Recipe payloads use the same `QRED1?...` fragment URL form as plaintext payloads and identify the selected reversible recipe with an `rc` query parameter, for example `rc=b45`. The `txt` query parameter carries the text for the selected transport form:

- when `rc` is absent or `rc=plaintext`, `txt` contains the canonical document text directly;
- when `rc` names a reversible recipe such as `b45`, `txt` contains the encoded recipe text.

The current reversible recipe is `b45` (`base45ish`). It MUST satisfy `decode(encode(text)) == text` before it can be selected for a seal. Its encoding rules are:

| Original text | Encoded text |
| --- | --- |
| `a`-`z` | `A`-`Z` |
| `A`-`Z` | `+A` ... `+Z` |
| `+` | `++` |
| `%` | `%%` |
| digits | unchanged |
| space and `.`, `-`, `/`, `:`, `$` | unchanged |
| all other characters | UTF-8 `%HH` byte escapes |

Verifiers reconstruct chunks first, then restore canonical text by decoding `txt` with the named `rc` recipe before signature verification. The restored canonical text, not the recipe-encoded transport text, is the text that is verified and presented as document content. Malformed recipe escapes, truncated escapes, invalid UTF-8 byte escapes, or characters outside the recipe alphabet MUST produce an error rather than a valid document.

---

# Key ID Derivation

The key_id is a stable identifier derived from the issuer's Ed25519 public key.

The reference implementation computes key_id as:

```
key_id = SHA-256(public_key_bytes).hexdigest()[:16]
```

The key_id is a 16-character lowercase hexadecimal string (64-bit).

The issuer registry validates key_id on registration: the caller-supplied key_id MUST match the computed value, or the registration returns a `400 Bad Request`.

---

# Chunking

Payloads exceeding the capacity of a single seal SHALL be divided into chunks.

When compression wins, the reference implementation splits the compressed base64 payload into fixed-size data chunks (200 bytes each).

Compressed QRed chunks are encoded as a pipe-delimited string:

```
QRED1|DOC-ABC123DEF456|0|3|<base64_gzip_data>
```

Where:

- `QRED1` = format identifier
- `DOC-ABC123DEF456` = document identifier
- `0` = chunk number (0-indexed)
- `3` = total chunks
- `<base64_gzip_data>` = chunk data

---

# Bootstrap Seal

A QRed document SHALL contain a bootstrap seal.

The bootstrap seal SHALL provide sufficient information to locate a verification application.

The reference implementation uses `https://qred.org/` as the default generated QRed payload URL base. Payload QR codes append QRed fragment data to that base, for example `https://qred.org/#QRED1?...`.

`https://qred.org/verify/v1` was an obsolete draft bootstrap URL and is not the current implementation default. New generated payload URLs SHOULD use `https://qred.org/` unless an issuer explicitly configures another bootstrap base.

The human-facing verifier route MAY also be served at `/verify.htm` (for example, `https://qred.org/verify.htm`) as a deployed verifier page. This route is distinct from the default payload URL base used for newly generated QRed payload QR codes.

Future versions may support additional bootstrap mechanisms.

---

# Signatures

QRed relies on Ed25519 public-key cryptography.

Implementations SHALL:

- Sign canonical document content using an Ed25519 private key.
- Verify signatures using the corresponding Ed25519 public key.
- Embed a key_id (derived from the public key) in the payload for registry lookup.

The issuer registry allows verification applications to look up public keys by (issuer_id, key_id).

---

# Issuer Registry

The issuer registry is a trusted key discovery mechanism for QRed verification.

The registry provides:

- Registration of (issuer_id, key_id, public_key) triplets.
- Key lookup by (issuer_id, key_id).
- Key validation: key_id MUST match the public key (SHA-256 derivation).

The reference implementation uses an in-memory dictionary. Production implementations may use a database, JSON file, or REST API.

---

# PDF Sealing Layout

PDF sealing layout is implementation-defined in v0.2 and may be standardized later.

The reference implementation produces seal strings suitable for QR code generation. The physical arrangement of seals on the document — including position, size, and number of QR codes per page — is left to the implementer.

For PDF sealing, the reference implementation seals each source page as an independently verifiable QRed payload. Before signing a page payload, it prefixes the canonical page text with integrity metadata containing:

- `Page SHA256`: the SHA-256 digest of that page's canonical text.
- `Document Merkle Root`: a Merkle-style root computed over the ordered list of page content hashes for the source PDF.

The Merkle root binds all page seals from the same source PDF without embedding a document identifier or page number in the signed text. For PDF page seals, the public QRed `doc` chunk-grouping parameter is a transport namespace derived from the Merkle root, the page content hash, and a per-seal occurrence number instead of a generated document ID. A verifier or recipient can compare the roots shown by scanned page seals: pages from the same sealed PDF share a root, while a swapped-in page from another PDF exposes a different root.

Future versions may standardize:

- Seal placement conventions (corner, margin, watermark).
- Minimum QR code dimensions.
- Multi-page seal distribution.
- Bootstrap vs. payload seal grouping.

---

# Verification Results

Verification applications SHALL report one of the following outcomes:

**VALID**
The payload was reconstructed successfully and the signature verified.

**INVALID**
The payload was reconstructed but signature verification failed.

**INCOMPLETE**
One or more required payload chunks could not be reconstructed.

**ERROR**
An unexpected processing error occurred.

---

# Versioning

QRed SHALL support version identifiers.

Implementations SHALL reject unsupported major versions.

Implementations MAY support multiple versions simultaneously.

---

# Security Considerations

QRed provides:

- Integrity verification
- Issuer authentication
- Tamper detection
- Key ID validation in the issuer registry

QRed does not provide:

- Confidentiality
- Revocation
- Identity proofing

Compromise of an issuer's private key compromises trust in documents issued by that key.

---

# Future Enhancements

Potential future enhancements include:

- Standardized PDF sealing layout
- Standardized multi-page document root formats
- Alternative seal formats
- Standardized canonicalization
- Offline public key distribution
- Revocation support
- Embedded document thumbnails
- Full Merkle proof payload structures
