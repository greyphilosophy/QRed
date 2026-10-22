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
4. In automatic mode, implementations SHALL evaluate plaintext and zlib candidates carried as scanner-safe hidden payloads, using gzip as a fallback when zlib is unavailable.
5. Only reversible candidates are selectable.
6. Automatic mode SHALL choose the candidate with the smallest QR count.
7. QR-count ties SHALL prefer fewer encoded payload bytes, then plaintext.
8. Explicit encoding strategies MAY request plaintext, zlib, or gzip.
9. The chosen payload form is divided into chunks and encoded into machine-readable seals.
10. The payload seals are placed on the document.

---

# Verification Workflow

1. User scans bootstrap seal.
2. Verification application loads.
3. Verification application scans payload seals.
4. Payload is reconstructed from all chunks.
5. Payload integrity is validated (all chunks present).
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

The current implementation uses the compact binary v3 record specified in
[COMPACT_SEALS_V3.md](docs/COMPACT_SEALS_V3.md). It contains a format/version
marker, signed timestamp, 8-byte key ID, 64-byte Ed25519 signature, and canonical
text (raw UTF-8, zlib, or gzip). Multipage PDFs additionally carry a signed page index,
page count, and full document root. Issuer names are omitted; trusted key-to-
authority mapping remains an external trust concern and future directory work.

A standalone record has no separately stored document ID or page hash. Its
collection ID is derived from its signature. A multipart record carries a full
record digest and binary chunk coordinates. Page hashes, and the document root
for single-page PDFs, are recomputed from recovered text.

The timestamp records the signer's clock, with millisecond precision; it is not
an independently certified time. It remains authenticated by the signature.
A JSON representation is provided for inspection only. Plaintext and compressed
QRs carry raw binary records behind the visible `QRED.ORG` marker. Automatic
mode selects the fewest QRs, then the fewest actual bytes; plaintext wins a tie.
Older seal formats are intentionally no longer verified.

---

# Key ID Derivation

The key_id is a stable identifier derived from the issuer's Ed25519 public key.

The reference implementation computes key_id as:

```
key_id = SHA-256(public_key_bytes).hexdigest()[:16]
```

The key_id is a 16-character lowercase hexadecimal string (64-bit).

A future trusted key directory should validate key IDs against public keys. Key IDs alone do not prove authority identity; recipients currently supply a trusted public key.

---

# Chunking

Payloads exceeding the capacity of a single seal SHALL be divided into chunks.

The reference implementation emits scanner-safe QR payloads that show the bootstrap URL to ordinary scanners and hide signed payload bytes in QR codewords. Ordinary camera apps deliver only the visible URL; hidden payload recovery requires a QRed-aware scanner reading the QR image itself. The implementation does not document or require an uppercase marker in the payload.

The removed compressed pipe seal format is intentionally omitted from this specification because there is no backward-compatibility requirement yet.

---

# Bootstrap Seal

A QRed document SHALL contain a bootstrap seal.

The bootstrap seal SHALL provide sufficient information to locate a verification application.

The reference implementation uses `https://qred.org/` as the default visible bootstrap URL. Payload QR codes visibly scan as that URL in ordinary camera apps, which pass only the URL to the browser. Signed payload bytes are hidden in QR codewords after the scanner-visible terminator and are recoverable only by a QRed-aware scanner reading the QR image.

`https://qred.org/verify/v1` was an obsolete draft bootstrap URL and is not the current implementation default. New generated payload QR codes SHOULD expose `https://qred.org/` as their visible scan result unless an issuer explicitly configures another bootstrap URL.

The human-facing verifier route MAY also be served at `/verify.htm` (for example, `https://qred.org/verify.htm`) as a deployed verifier page. This route is distinct from the default visible bootstrap URL used for newly generated QRed payload QR codes.

Future versions may support additional bootstrap mechanisms.

---

# Signatures

QRed relies on Ed25519 public-key cryptography.

Implementations SHALL:

- Sign canonical document content using an Ed25519 private key.
- Verify signatures using the corresponding Ed25519 public key.
- Embed a key_id (derived from the public key) in the payload for registry lookup.

A future issuer directory can map key IDs to trusted public keys and authority names without embedding names in seals.

---

# Issuer Registry

A trusted issuer directory is planned; its publication and registration mechanism have not been selected.

The registry provides:

- Trusted association of authority names, key IDs, and public keys.
- Key lookup by key ID.
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
