# Experimental exact rendered appearance

This opt-in, digital-PDF-only experiment is separate from ordinary QRed text,
OCR, visual-reference, account-sealing and photo verification. It does not
change their evidence or turn an OCR disagreement into a successful result.
It is not enabled by the ordinary PDF sealing or verification controls.

## What a match means

An authenticated page receives `exact-render-match` only when its sampled
144 dpi RGBA raster is byte-for-byte equal to the signer's raster, except for
seal artwork that is independently reconstructed and itself checked byte for
byte. There are no fuzzy thresholds, ignored quiet zones, OCR masks or
unverified exclusion rectangles. This is a finite-resolution appearance
claim, not universal document integrity.

A match does **not** establish:

- Identical PDF bytes, hidden text, metadata, attachments, links or semantics.
- Accurate OCR, correct amounts, true assertions, or the signer's real-world
  identity without a trusted public key.
- Identical appearance in another PDF reader, browser, OS or rendering setup.
- Physical print, camera, screenshot or photograph verification.
- Detection of a mark that disappears during the defined finite rasterization.

Hidden text and metadata changes are intentionally covered by a passing scope
test. Visible, very faint and outlined marks are covered by rejecting tests.
Never replace a mismatch with tolerant alignment or a visual-confidence score.

`signatureStatus` and `exactRender.status` are different fields. A valid
signature may accompany an unsupported profile, invalid manifest, different
pixels or incomplete document. Such an appearance check is `inconclusive`.
It must not be labeled tampered solely because a different rasterizer produced
different pixels. A whole-document result additionally requires ordered page
positions, a common signing key and timestamp, the declared count, and a
recomputed document root over every ordered signed source raster hash and size.

## Renderer procedure and compatibility

`renderer.js` selects a local procedure. A document cannot choose URLs,
renderer code, font files, arbitrary options or a fallback implementation.
The browser procedure identifier is:

`qred-exact-browser-canvas-v1/pdfjs-6.1.200/paths/rgba8-srgb-white/scale2`

The Node unit-test procedure uses `node-test` instead of `browser-canvas` and
is deliberately incompatible. A Node success is not browser qualification.

The procedure fixes PDF.js 6.1.200, its same-origin bundled CMaps, standard
fonts and WASM assets, `disableFontFace: true`, `useSystemFonts: false`,
`isEvalSupported: false`, `stopAtErrors: true`, `enableXfa: false`,
`isOffscreenCanvasSupported: false`, `isImageDecoderSupported: false`,
`enableHWA: false`, `useWasm: true`, display intent, enabled annotations mode,
white background and scale 2. Source pages with forms or display annotations
are rejected in this initial scope. Missing/invalid font paths are rejected
rather than replaced by OS fonts. The default optional-content state is used;
there is no layer-selection UI or document-controlled runtime configuration.

This identifier is a versioned **implemented procedure**, not cryptographic
attestation of a browser, GPU, runtime or fetched asset set. Native Canvas2D
path rasterization, color handling and compositing can differ across systems.
Even disabling browser font faces and native image decoding does not eliminate
those differences. Such differences can cause false-negative/inconclusive
results; they never justify accepting unequal pixels. No cross-platform
deterministic-renderer claim is made. Procedure changes require a new profile
version and deliberate compatibility handling. A measured asset/runtime
registry is a future release-hardening topic, not an established property of
this experiment.

Do not use PDF.js `maxImageSize` as an evidence-preserving resource cap: that
option may omit large images rather than reject the document. This experiment
does not set it. Output-raster bounds are enforced before canvas allocation.

## Signed format and trust boundary

The ordinary QRS3 signature domain, timestamp/key/page metadata and Ed25519
verification are reused without changing their rules. The signed
`page_evidence` flag is set, and the uncompressed page body is:

1. One byte with value `3` (a new, distinct page-body version).
2. Strict UTF-8, compact canonical JSON, at most 4,095 further bytes.

Old readers reject this body as an unsupported page-evidence version. It must
never be encoded as ordinary prose or presented to a text/OCR consumer.
The dedicated exact verifier accepts only QRS3 local-key signatures and
uncompressed exact bodies, carried by twelve-of-sixteen QRE3 shards. QRS4,
account attestations, compression and ordinary text records are unsupported
in this initial experiment. It does not add a decompression path.

The complete QRE record must reconstruct with the existing record digest and
parity checks. Conflicting or extra foreign observations are not silently
dropped. The exact verifier then checks the trusted public-key ID and ordinary
Ed25519 signature over the complete raw body and metadata. Only after this
succeeds may it parse the manifest, accept signed geometry or render artwork.

The closed manifest schema contains `type`, `version`, `profile`, `style`,
`width`, `height`, `scale`, `rotation`, `userUnit`, `bounds`, `page`, `pages`,
`sourceSha256`, `documentRoot`, `required`, `total` and `boxes`. Unknown fields,
duplicate/noncanonical JSON, malformed hashes, invalid geometry, overlapping
boxes and mismatched envelope page context fail closed. The type is
`QRED-EXACT-RENDER`, manifest version is 1, and the artwork procedure is
`qred-exact-qr-v1/M/quiet4/gray0.85/normal`. That artwork uses the existing
locked QR encoder and PDF vector-drawing helper; future changes to those
procedures require a new style/profile version.

## Pixel coverage argument

Let S be the signed source raster, A the union of signed disjoint seal boxes,
T the independently regenerated artwork raster, and O the observed raster.
Generation requires S to be exactly opaque white throughout A and a
four-pixel surrounding guard. It signs SHA-256(S), full geometry and A.

Verification authenticates the record, regenerates all sixteen symbols from
that exact record on a new blank PDF, and requires O restricted to A to equal
T restricted to A in every RGBA byte. It also checks that T paints nothing
outside A. Only after those checks may it set A to white in a copy of O and
compare the hash to SHA-256(S). Assuming ordinary signature and SHA-256
security, every sampled pixel is accounted for. Merely recovering twelve
shards is not sufficient: all sixteen entire artwork boxes must agree.

## Input, memory and cancellation limits

- Digital PDFs of 1 to 100 pages and at most 32 MiB, checked before and after
  reading the input bytes.
- Standard unit, zero rotation, origin-zero visible crop, integral raster
  dimensions, scale 2 and at most 3,000,000 pixels per page.
- Sixteen fixed 173-by-173 pixel boxes (86.5 pt), at least 36 pt from the
  page edge plus the four-pixel source guard. Selection uses source pixels
  only, before signing, with eight bounded traversal orders.
- QR error correction M, four-module quiet zones, normal blend and 0.85 gray.
  Actual payloads must retain at least 1.25 pt per QR module. No resizing,
  footer/scaling fallback, evidence reduction or signature reroll forces a fit.
- Pages are rasterized sequentially. Placement retains an integral-image
  array; comparison retains observed/overlay/restored RGBA and a coverage map.
  At 3 MP the latter typed-array accounting is about 39 MB, excluding parser,
  PDF-lib, canvas, QR scanner, input/output and runtime allocations.
- Abort checkpoints bound placement loops and occur between awaited stages.
  Active PDF.js render/load operations are cancelled and canvases destroyed.
  This is not a hard CPU/memory sandbox for adversarial PDF parser workloads.

Sealing returns no output unless the actual saved PDF passes independent
optical recovery, signature verification and exact pixel/document comparison.
That preflight does not reuse source rasters or pass generated records into
the verifier as trusted sidecars.

## Privacy and offline behavior

PDFs, raster pixels, hashes, manifests and keys stay in memory on the device.
The exact modules have no upload, telemetry or document-storage path. Generated
PDF and key downloads are explicit user actions. Normal page navigation and
public static-asset downloads remain network activity.

PDF.js assets are already bundled under the site's versioned same-origin
paths and use the existing service worker. First-use fonts, CMaps or codecs
may need downloading. Offline verification is supported only when all needed
resources are available; absence must fail, never silently choose a font.
Test with a non-sensitive fixture before relying on airplane mode. Static
resources may be cached; document bytes and private keys must not enter cache,
IndexedDB, localStorage, URLs or logs. Clearing or closing the experimental
tool aborts its work, releases references and revokes its download URLs.

## APIs and release gates

`sealExactPdf({ file, privateKey, publicKey, signal, onProgress })` returns a
`blob` and the full independent verification result after successful preflight.
`verifyExactPdf({ file, publicKey, signal, onProgress })` returns `pages`,
`completeExactRenderedDocument`, `profile` and `scope`. Each page separates
`signatureStatus` from `exactRender: { status, reason }`. Progress events
contain `stage`, `pageNumber` and `pageCount`. Unsupported input/load errors
and cancellation reject the promise; page-specific verification failures are
reported as inconclusive. No ordinary OCR state is modified.

Before publishing or promoting the experiment, run unit/schema/cryptographic
and real rendered-PDF tests, all existing regressions, and real-browser CI
that seals and verifies its own browser-generated output. Browser tests must
cover altered marks, hidden metadata scope, cold and warmed offline behavior,
private-state cleanup, repeated operations, changed keys/files, cancellation
and no document transmissions. Passing Node tests or accepting a Node-created
profile in the browser is not an acceptable substitute. Wider browser/OS
qualification and a future deterministic software renderer remain separate.
