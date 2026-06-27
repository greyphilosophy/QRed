# QRed Business Rules

This document summarizes the current business rules for QRed as implemented and specified in this repository. It is intended as a product-facing companion to the formal requirements and technical specification.

## Scope and Intent

1. QRed exists to make printed documents tamper-evident by embedding a signed representation of certified document contents into QR-code seals printed with the document.
2. A recipient must be able to verify certified contents with commonly available smartphone hardware and a modern mobile browser.
3. QRed verification must not require recipients to install a dedicated mobile application.
4. The sealed document should carry the information needed to validate its certified contents after the payload seals have been acquired.
5. QRed is an open, publicly documented, interoperable format so independent implementations can generate and validate compatible documents.

## Document Sealing Rules

1. The system accepts one or more source documents for sealing.
2. Before signing, document content is converted into a deterministic canonical text representation.
3. Canonicalization preserves certified text content while excluding non-essential formatting.
4. The reference canonicalization process:
   - splits text on line endings,
   - strips trailing whitespace from each line,
   - collapses consecutive blank lines to a single blank line, and
   - strips leading and trailing empty lines.
5. The canonical text is signed by the issuing authority using Ed25519.
6. The signed payload is encoded into one or more machine-readable payload seals.
7. Automatic mode evaluates all reversible supported payload candidates, currently plaintext fragment URLs, reversible recipe payloads such as `b45`, and legacy compressed `QRED1|...` payloads.
8. Only reversible candidates are selectable.
9. Automatic mode chooses the candidate that requires the fewest QR codes.
10. QR-count ties prefer plaintext `QRED1?...` fragment payloads, then recipe encodings, then compressed legacy `QRED1|...` payloads.
11. Explicit strategies may request `plaintext`, `b45`, or implementation-supported legacy compression aliases such as `legacy_compression`.
12. Payloads that exceed a single seal's capacity are divided into numbered chunks.
13. Printed QR payload URLs use the shortest production verifier origin currently required for scanning: `https://qred.org/`.
14. Fragment payload seals append QRed data after the hash, for example `https://qred.org/#QRED1?...`, so the URL path does not consume QR capacity.
15. The `/verify.htm` route may remain available as a human-facing verifier page, but newly generated QR payloads must not add `/verify.htm` unless a future compatibility requirement explicitly requires it.

## Payload and Metadata Rules

1. A QRed payload contains the format version, issuer identifier, key ID, document identifier, creation timestamp, canonical content, signature metadata, and digital signature.
2. Payloads include a `key_id` derived from the issuer public key.
3. The reference key ID is the first 16 lowercase hexadecimal characters of the SHA-256 digest of the Ed25519 public key bytes.
4. The issuer private key must never be embedded in generated seals.
5. Unsupported major format versions are rejected.
6. Implementations may support multiple versions simultaneously when backward compatibility is practical.

## Issuer and Key Trust Rules

1. Verification uses public-key cryptography; issuer private keys are only used for signing.
2. Verification must not require access to issuer private keys.
3. Recipients must be able to determine whether a document was issued by a trusted authority.
4. Verification requires a trusted public key source, either an explicitly supplied trusted public key or an issuer registry lookup.
5. The issuer registry maps issuer identifiers and key IDs to issuer public keys.
6. The issuer registry validates registrations by recomputing the key ID from the public key.
7. Registry registration is rejected when the submitted key ID does not match the submitted public key.
8. Missing registry keys are treated as lookup failures, not successful verification.

## Verification Rules

1. The verification workflow scans one or more QRed payload URLs, loads the verifier from the short `https://qred.org/` origin when needed, reconstructs the payload, validates payload completeness, verifies the signature, displays certified contents, and reports a result.
2. Payload reconstruction requires all chunks for the same document or grouping namespace.
3. Missing chunks produce an `INCOMPLETE` result.
4. Malformed, unsupported, or unreadable seal data produces an `ERROR` result when it cannot be reconstructed.
5. Mixed document IDs or incompatible chunk groups are invalid and must not be accepted as a valid reconstructed document.
6. A successfully reconstructed payload whose signature verifies is `VALID`.
7. A successfully reconstructed payload whose signature does not verify is `INVALID`.
8. Any modification to certified contents invalidates verification.
9. Verification displays the certified contents contained in the seals.
10. The scanner interface displays arbitrary QR payload contents, not only QRed seals.
11. Verification should be capable of operating without transmitting document contents to a third party.
12. The mobile verifier verifies locally after payload acquisition.

## PDF Sealing Rules

1. Backend PDF sealing applies QRed seals to each source PDF page so each page can be independently verified.
2. PDF sealing rejects non-PDF uploads.
3. PDF sealing rejects PDFs with no pages.
4. PDF seal layout must fit at least one QRed payload QR code; otherwise sealing is rejected.
5. PDF stamping must not drop payload seals; overflow pages are appended when the source pages cannot hold all required seals.
6. For page-level PDF sealing, signed page content includes a page content SHA-256 digest and a document Merkle root.
7. Page seals from the same sealed PDF share a document Merkle root so swapped-in pages from another PDF expose a different root.
8. Duplicate or repeated page content must still receive non-colliding QR grouping namespaces.

## Deployment and Operations Rules

1. Generated QR payload URLs are expected to use `https://qred.org/` as their production base URL.
2. Production should use Cloudflare Pages for the frontend verifier deployment.
3. GoDaddy forwarding must not be used as the primary production mechanism for `qred.org` verification traffic.
4. If API-backed production features are enabled, the frontend Worker must be configured with the backend API origin or the browser build must be configured with the backend API base URL.
5. If no backend origin is configured, the static Worker may serve demo issuer keys but must return a clear `503` for unsupported backend API routes.

## Security Boundary and Non-Goals

1. QRed provides integrity verification, issuer authentication, tamper detection, and key ID validation.
2. QRed does not provide confidentiality; sealed contents may be visible to authorized viewers and QR scanners.
3. QRed does not provide identity proofing.
4. QRed does not provide authorization decisions.
5. QRed does not provide revocation services in the current scope.
6. QRed does not prevent unauthorized copying, physical theft, photocopying, or reprinting of documents.
7. QRed does not protect documents if an issuer private key is compromised.
8. QRed is not a replacement for PKI infrastructure.

## Success Rules

QRed is successful when a recipient can:

1. scan a document using a smartphone,
2. reconstruct the certified contents,
3. verify the issuer signature,
4. detect unauthorized modifications, and
5. complete verification without installing a dedicated application.
