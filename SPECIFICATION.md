# QRed Specification

Version: 0.1 Draft

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
3. The canonical text is digitally signed.
4. The signed payload is compressed.
5. The payload is divided into chunks.
6. Chunks are encoded into machine-readable seals.
7. The bootstrap seal and payload seals are placed on the document.

---

# Verification Workflow

1. User scans bootstrap seal.
2. Verification application loads.
3. Verification application scans payload seals.
4. Payload is reconstructed.
5. Payload integrity is validated.
6. Digital signature is verified.
7. Certified contents are displayed.
8. Verification result is displayed.

---

# Canonical Representation

Implementations SHALL produce a deterministic text representation of the certified document contents.

The canonical representation MUST:

- Preserve certified text content.
- Produce identical output for identical document contents.
- Exclude non-essential formatting.

The exact canonicalization algorithm is implementation-defined.

Future versions may standardize canonicalization.

---

# Payload Structure

A QRed payload SHALL contain:

- Format version
- Issuer identifier
- Document identifier
- Creation timestamp
- Canonical document text
- Signature metadata
- Digital signature

Example logical structure:

{
"version": "1",
"issuer": "Example Authority",
"document_id": "123456",
"timestamp": "2026-06-18T00:00:00Z",
"content": "...",
"signature": "..."
}

The physical encoding format is implementation-defined.

---

# Chunking

Payloads exceeding the capacity of a single seal SHALL be divided into chunks.

Each chunk SHALL contain:

- Format identifier
- Document identifier
- Chunk number
- Total chunk count
- Payload data

Example:

QRED1|DOC123|2|5|<data>

Where:

- QRED1 = format identifier
- DOC123 = document identifier
- 2 = chunk number
- 5 = total chunks

---

# Bootstrap Seal

A QRed document SHALL contain a bootstrap seal.

The bootstrap seal SHALL provide sufficient information to locate a verification application.

Example:

https://example.org/qred

Future versions may support additional bootstrap mechanisms.

---

# Compression

Payload compression is OPTIONAL.

Supported compression methods SHALL be identified within the payload metadata.

The initial reference implementation may use GZIP.

Future versions may define additional compression methods.

---

# Signatures

QRed relies on public-key cryptography.

Implementations SHALL:

- Sign canonical document content.
- Verify signatures using a corresponding public key.

The specific signature algorithm is implementation-defined.

Future versions may define mandatory algorithms.

---

# Verification Results

Verification applications SHALL report one of the following outcomes:

VALID
The payload was reconstructed successfully and the signature verified.

INVALID
The payload was reconstructed but signature verification failed.

INCOMPLETE
One or more required payload chunks could not be reconstructed.

ERROR
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

QRed does not provide:

- Confidentiality
- Revocation
- Identity proofing

Compromise of an issuer's private key compromises trust in documents issued by that key.

---

# Reference Architecture

Bootstrap Seal
↓
Verification Application
↓
Payload Seal Scan
↓
Payload Reconstruction
↓
Signature Verification
↓
Certified Content Display

---

# Future Enhancements

Potential future enhancements include:

- Multi-page document support
- Alternative seal formats
- Standardized canonicalization
- Standardized signature algorithms
- Offline public key distribution
- Revocation support
- Embedded document thumbnails
- Merkle-tree payload structures
