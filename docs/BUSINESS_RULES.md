# QRed Business Rules

Current behavior after [PR #163](https://github.com/greyphilosophy/QRed/pull/163),
merged November 1, 2026 (Pacific time). See [Compact seals v3](COMPACT_SEALS_V3.md),
[account attestations](ACCOUNT_ATTESTATION.md), and [watermark recovery](WATERMARK_DECODING.md)
for protocol details.

## Scope and processing

1. QRed embeds signed document evidence in printed QR seals so recipients can recover it and compare it with a document.
2. PDF preparation, text extraction, QR generation, scanning and verification happen in the browser. No document-processing backend or app installation is required.
3. Local-key sealing works offline after required resources load. Optional account sealing requires an online provider and QRed Worker attestation for each document.
4. Account sealing sends deterministic, unsalted SHA-256 page commitments and account metadata to the Worker, not PDF bytes, filenames, extracted text or the raw document root. A party with access to requests could correlate commitments or test guesses about known contents.
5. Google, Microsoft and Amazon are independently configured. Document-bound sign-in sessions expire five minutes after creation; polling and retries do not extend that deadline.

## Evidence and signatures

1. The UI prepares one selected PDF at a time. Supported form fields are flattened before extraction; unsupported forms, inconsistent appearances and missing required fonts stop sealing.
2. Text canonicalization removes trailing whitespace, collapses repeated blank lines and removes leading/trailing blank lines. It does not preserve every visual feature of the source PDF.
3. Text pages contain canonical text and may use spare capacity for signed line positions and a lossy grayscale reference. Image-only pages use a visual reference; blank pages use an explicit marker. Optional evidence must not add QR codes beyond the count needed for text.
4. Local seals use Ed25519 and compact v3 records. Account-backed v4 seals bind a page commitment to provider identity, authority key ID and server time. Their signature is checked with a bundled trusted authority key.
5. Multipage seals include signed page position/count and a shared document root. These support grouping and detection of mixed documents; they do not prove every printed page is present until collection is complete.
6. A key ID is eight SHA-256 digest bytes, displayed as 16 lowercase hexadecimal characters. Private keys are never included in seals.
7. Local seals omit a freeform issuer name. Account seals include provider, profile name, email, provider-scoped account identifier and attestation time. Anyone with a copy can recover this evidence; compression and signing do not encrypt it.

## QR transport and compatibility

1. Each payload QR contains one ordinary byte segment with a binary record or chunk. It contains no navigation URL, and no application data follows the QR terminator.
2. Version 40-L holds at most 2,953 message bytes, including any QRed chunk header. Chunk indices and a record digest support reconstruction; duplicate identical scans are harmless, but conflicting chunks are rejected.
3. Automatic encoding compares plaintext and zlib by QR count, then payload bytes, preferring plaintext on a tie. It tries gzip if zlib compression is unavailable. Explicit compression remains an API option; the UI uses automatic selection.
4. Copyable v3/v4 seal strings remain supported. QR images using the retired post-terminator padding layout are not supported and must be re-sealed. Deploy the stamper and both verifier routes together and refresh offline copies.
5. A separate navigation QR opens qred.org from the first stamped page or an appended seal sheet. It is required in first-page footer layouts and optional over a watermark. Every sealed page retains the printed verification instruction.
6. Rectangular watermark cells and reconstructed quiet zones are experimental geometry for QRed's scanner. Standard message encoding is not a claim of full JIS/ISO symbol conformance or generic-camera readability. See [licensing and compatibility](LICENSING_AND_COMPATIBILITY.md).

## PDF layout

1. A physical sheet carries up to four payload QR codes. A watermark uses one full-page symbol or exactly four balanced pieces. Explicit footer layouts may use one through four codes.
2. Automatic mode first tries rectangular watermarks on text pages, then verified square fallbacks and a footer when needed. Image-only and blank pages use footers.
3. Full-page watermarks share one physical margin across the document: 54 points by default, reduced to 36 points when any original rendered page has at least four square points of visible ink within half an inch of an edge. Navigation panels and square fallbacks retain 54-point clearance.
4. A navigation overlay must avoid original page marks and keep its own quiet zone. Both the navigation code and all signed chunks must pass clean and softened/shaded recovery checks. If it fails, try the text-only instruction before a footer.
5. Watermarks preserve original page dimensions. Footer fallback extends Letter to Legal or shrinks other page contents to reserve space; the UI reports affected pages.
6. Never omit a chunk or silently create overflow pages. Footer and watermark-only layouts enforce the four-code limit per original. Preflight demonstrates recovery under tested conditions, not guaranteed printer/camera reliability.

7. The default **Watermark with appended overflow** layout appends only the seals that could not be placed readably on their original pages. **Append seal sheets** appends every seal. Each appended piece is labeled with the original page and part number. Only originals count toward signed page totals and account receipts. The signable form snapshot is validated while the output retains the original fields. In hybrid mode a readable watermark stays on the original even if its optional navigation instruction cannot fit. Every appendix sheet has the verifier address and navigation QR.

## Verification and trust

1. Both verifier routes read camera frames, selected photos and PDFs locally. Reconstructed evidence still needs signature verification.
2. **INCOMPLETE** means chunks are missing; **ERROR** means malformed/unsupported data or a decoding failure; **UNVERIFIED** means no trusted key is available. Invalid signatures or conflicting seal sets cannot produce **VALID**.
3. **VALID** means the reconstructed signed evidence verifies with the selected trusted key. It does not automatically authenticate every visible mark, prove legal identity or establish organizational signing authority.
4. Recipients obtain local issuer public keys independently through a trusted channel. Account seals select a bundled authority key by ID. An unknown authority remains unverified; a key embedded by an untrusted sender would not establish trust.
5. There is no public issuer-registration service or live revocation service. Offline copies cannot learn about changed trust keys until updated.
6. Recipients compare signed text and visual references with the document. OCR and lossy images can miss changes; altering paper while leaving its QR intact does not itself invalidate the QR signature.
7. Live scanning prefers the main rear camera at 1×, uses a page guide and bounded worker attempts, and leaves lengthy refinement to selected images or explicit photo capture. Photo recovery is cancellable. Hardware support varies by browser.

## Security and disclosure boundaries

QRed does not provide confidentiality, legal identity proofing, authorization,
protection against copying, or protection after signing-key compromise. It is
not represented as CJIS-approved or generally suitable for regulated records.
Public code and tests support evaluation; they are not security certification,
patent clearance or proof of physical print reliability.

The [privacy](../frontend/public/privacy.html), [data deletion](../frontend/public/data-deletion.html),
[terms](../frontend/public/terms.html), and [security](../frontend/public/security.html)
pages describe the public service boundaries. Keep them aligned with changes
to data handling, identity, transport and compatibility.
