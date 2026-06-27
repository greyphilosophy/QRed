# QRed Business Requirements

**Status:** Draft\
**Version:** 1.0

## 1. Product Purpose

1.  QRed shall make printed and shared documents tamper-evident.
2.  QRed shall allow recipients to compare visible document contents
    with cryptographically certified contents.
3.  QRed shall prioritize human readability whenever practical.
4.  QRed shall prefer representations that maximize human readability
    while preserving cryptographic integrity and minimizing QR usage.
5.  QRed shall remain an open, publicly documented, interoperable
    format.

## 2. User Discovery

1.  First-time users shall be able to discover what a QRed seal is.
2.  At least one supported seal format shall work with ordinary
    smartphone QR scanning.
3.  QRed shall not require a dedicated native application for basic
    verification.
4.  Compact raw seal formats may require a QRed-aware scanner.
5.  Raw seals shall remain visibly identifiable as QRed seals.

## 3. Graceful Degradation

1.  The scanner shall scan arbitrary QR codes.
2.  Unknown QR contents shall be displayed instead of silently rejected.
3.  Incomplete payloads shall explain what is missing.
4.  If verification cannot be completed, the reason shall be clearly
    reported.
5.  If a reversible recipe cannot be used, the system shall
    automatically fall back to another supported encoding.

## 4. Canonicalization

1.  Documents shall be converted into deterministic canonical text
    before signing.
2.  Canonicalization shall preserve certified content while discarding
    non-essential formatting.
3.  The canonical text is the authoritative representation for signing
    and verification.

## 5. Signing and Verification

1.  Issuer private keys shall only be used for signing.
2.  Verification shall use trusted public keys.
3.  Any modification to certified contents shall invalidate
    verification.
4.  Verification results shall include VALID, INVALID, INCOMPLETE, or
    ERROR.

## 6. Payload Formats

1.  QRed shall support plaintext payloads.
2.  QRed shall support reversible text recipes.
3.  QRed shall support compressed payloads for compatibility.
4.  Payloads shall contain sufficient information to reconstruct and
    verify certified contents.

## 7. Encoding Selection

1.  Plaintext shall be preferred when it is not worse than alternatives.
2.  Automatic mode shall evaluate all supported reversible recipes.
3.  Automatic mode shall evaluate compressed encodings.
4.  Only reversible encodings may be selected.
5.  Selection shall prioritize:
    -   reversibility,
    -   fewer QR codes,
    -   readability,
    -   simplicity.

## 8. Reversible Recipes

1.  Recipes shall satisfy:

        decode(encode(text)) == text

2.  Recipes shall decode into canonical text before verification.

3.  Signatures shall verify restored canonical text, never encoded
    representations.

4.  Failed recipes should provide actionable diagnostics.

5.  Recipes shall be extensible without redesigning the verification
    pipeline.

## 9. Chunking

1.  Large payloads shall be divided into chunks.
2.  Missing chunks shall prevent successful verification.
3.  Reconstruction shall be deterministic.

## 10. Trust

1.  Trusted issuers shall be identified by public keys.
2.  Registries shall validate issuer registrations.
3.  Missing trust information shall never imply successful verification.

## 11. PDF Sealing

1.  QRed shall support PDF sealing.
2.  Individual pages may be independently verifiable.
3.  Page substitution shall be detectable.

## 12. Security Boundaries

1.  QRed provides integrity verification.
2.  QRed provides issuer authentication when trusted keys are available.
3.  QRed does not provide confidentiality.
4.  QRed does not prevent copying, photography, or physical theft.
5.  QRed is not a replacement for a complete PKI.

## 13. Success Criteria

QRed succeeds when a recipient can:

1.  Discover what a QRed seal is.
2.  Scan the document.
3.  Acquire all required payload data.
4.  Reconstruct certified contents.
5.  Verify the issuer signature.
6.  Detect unauthorized modifications.
7.  Complete the core verification workflow without installing a native
    application.
