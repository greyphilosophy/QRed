# QRed Requirements

# Purpose

QRed is intended to provide a practical method for detecting tampering of printed documents by embedding a signed representation of the document within one or more machine-readable seals printed on the document itself.

The system is designed to allow recipients to verify the certified contents of a document using a standard smartphone without requiring a dedicated mobile application.

---

# Problem Statement

Printed documents may be altered after issuance through editing, redaction, substitution, photocopy manipulation, or re-creation.

Recipients often have no practical way to determine whether a document accurately reflects the contents originally issued by the certifying authority.

QRed addresses this problem by embedding a cryptographically signed representation of the document directly on the printed document.

---

# Goals

G1. Tamper Detection

The system shall enable recipients to detect whether the certified contents of a document have been modified after issuance.

G2. Smartphone Verification

The system shall support verification using commonly available smartphone hardware.

G3. No Dedicated Application

The system shall not require installation of a dedicated mobile application.

G4. Self-Contained Verification

The information required to validate the certified contents shall be carried by the document itself.

G5. Open Standard

The format shall be publicly documented and implementable by independent parties.

G6. Multi-Page Support

The system shall support documents whose contents exceed the capacity of a single machine-readable seal.

G7. Public-Key Verification

The system shall support verification using public-key cryptography.

G8. Interoperability

Independent implementations shall be capable of generating and validating compatible QRed documents.

---

# Functional Requirements

FR1. Document Input

The system shall accept one or more source documents.

FR2. Canonical Representation

The system shall derive a canonical text representation of the document suitable for signing and verification.

FR3. Digital Signature

The canonical representation shall be digitally signed by the issuing authority.

FR4. Seal Generation

The signed payload shall be encoded into one or more machine-readable seals. In automatic mode, implementations shall evaluate all reversible supported candidates, currently plaintext fragment URLs and reversible recipe payloads such as `b45`. Only reversible candidates are selectable; automatic mode shall minimize QR count, with ties preferring plaintext, then recipe encodings. Explicit strategies may request `plaintext`, `b45`, or implementation-supported modular recipes.

FR5. Bootstrap Seal

The document shall contain a bootstrap seal that directs recipients to a verification application.

FR6. Payload Reconstruction

The verification application shall reconstruct the original signed payload from the document seals.

FR7. Signature Verification

The verification application shall verify the digital signature using the issuer's public key.

FR8. Content Display

The verification application shall display the certified contents contained within the seals.

FR8a. Universal QR Scanning

The scanner interface shall display the contents of arbitrary QR payloads, not only QRed seals.

FR9. Verification Result

The verification application shall indicate whether verification succeeded or failed.

FR10. Version Support

The format shall support future revisions while maintaining backward compatibility where practical.

---

# Non-Functional Requirements

NFR1. Open Specification

The specification shall be publicly available.

NFR2. Platform Independence

The verification application shall operate on modern mobile browsers.

NFR3. Reasonable Performance

Verification should complete within a few seconds under normal conditions.

NFR4. Fault Tolerance

The system should tolerate minor printing defects and scanning imperfections.

NFR5. Extensibility

The format shall support future enhancements without invalidating existing documents.

---

# Security Requirements

SR1. Integrity Protection

Modification of certified document contents shall invalidate verification.

SR2. Issuer Authentication

Recipients shall be able to determine whether a document was issued by a trusted authority.

SR3. Public-Key Architecture

Verification shall not require access to issuer private keys.

SR4. Resistance to Casual Forgery

The effort required to forge a valid QRed seal shall exceed the capabilities of typical document editing tools.

SR5. Offline Verification Capability

Verification should be capable of operating without transmitting document contents to a third party.

---

# Out of Scope

The following are outside the scope of QRed:

- Identity verification
- Authorization decisions
- Revocation services
- Encryption of document contents
- Long-term archival standards
- Protection against physical theft or copying
- Protection against compromise of issuer private keys

---

# Success Criteria

QRed shall be considered successful if a recipient can:

1. Scan a document using a smartphone.
2. Reconstruct the certified contents.
3. Verify the issuer's signature.
4. Detect unauthorized modifications.
5. Perform verification without installing a dedicated application.
