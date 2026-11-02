# QRed

QRed is a publicly documented experimental format and reference implementation for tamper-evident document sealing and verification. It is not a standards-body certification.

QRed encodes the signed contents of a document into one or more QR code seals printed alongside the document. Seal QR codes carry the signed binary record in an ordinary QR byte segment. A separate navigation QR opens qred.org from the first page: it is required in footer layouts and included on watermark pages when it fits; the printed “Verify at QRED.ORG” instruction remains available on every sealed page.

No app installation is required.

Local seals use compact v3 binary records with signed text, timestamp, key ID,
and page context. Issuer names are omitted. Older seals must be re-sealed.
Image-only pages carry a signed grayscale visual reference; blank pages carry an
explicit signed blank-page marker. Text pages use spare capacity for line positions
and an approximate visual reference, without adding QR codes. Experimental
watermark mode uses one page-filling QR or splits overflow into four balanced
quadrant QRs. Full-page watermarks share one document-wide margin: **0.75 inch
by default, or 0.5 inch when any original page has sufficient visible ink
within half an inch of an edge**. Square fallbacks retain 0.75-inch clearance.
The minimum module-size check may rule out four dense v40 symbols on US Letter. The original
PDF content itself remains unchanged and may still reach closer to an edge;
for best results print at 100% / Actual size. Explicit footer mode retains ordinary QR counts up to four. See [page references](docs/PAGE_REFERENCES.md) and
[Compact seals v3](docs/COMPACT_SEALS_V3.md) for scope, compatibility, and tests.
Supported PDF forms are automatically flattened before text extraction and
signing. Text fields and dropdowns are checked against their saved appearances;
unsupported or inconsistent forms stop with an actionable error. Review the
values in the downloaded copy. Missing fonts or character maps stop sealing
instead of signing only the readable portion of a page. Checkbox/radio marks
remain visible graphics and are not authenticated by the text signature.

# Quick Start

## Run the demo

```bash
git clone https://github.com/greyphilosophy/QRed
cd QRed
cd frontend
npm ci && npm start
```

The demo app runs at `http://localhost:3000`. Local private-key sealing and QR processing run in the browser without a backend. Optional account sealing uses a Cloudflare Worker to attest deterministic, unsalted SHA-256 page commitments; PDFs and document text stay on the device. A party with access to Worker request data could correlate repeated commitments or test guesses about known contents. See [account sign-in setup](docs/ACCOUNT_ATTESTATION.md).

Use Node 24. For PDF raster regression tests, install `poppler-utils`
(`pdftoppm`).

## Start the development server

```bash
cd frontend
npm install
npm start
```

Open `http://localhost:3000` in your browser. Click "Open PDF stamping tool" to open a PDF from your device and seal it in-browser.

## Generate signing keys and stamp a PDF

1. Open the PDF stamping tool and click **Generate key pair**. QRed creates a fresh Ed25519 pair using the browser's secure random generator and fills both key fields. Use HTTPS or localhost with Web Crypto support.
2. **Save private key** and keep the file private. It is an unencrypted text file; QRed does not keep a copy, and closing the tool or reloading clears it. Anyone with this key can sign as you.
3. **Save public key** to share with recipients through a trusted channel. This file contains only the public key.
4. Choose a PDF and click **Stamp and save PDF**.
5. To test your seals on the same page, click **Use public key to verify**. This sets the key in **Verify collected seals**, where you can scan or choose the QR images from your stamped PDF. Recipients can choose **Open issuer public key file** on the home page or standalone verifier.

Letter-to-legal stamping preserves the original letter content at its original
size and uses the added three-inch footer for QR seals. One or two seals are
2.75 inches square, including their quiet zones, with a quarter-inch bottom
print margin. Larger sets use the grid that allows the largest codes within
that same footer. If the first page uses footer seals, its footer also includes
a separate half-inch navigation QR opening `https://qred.org/`. The layout uses
an empty grid cell or reserves a separate column, keeping all quiet zones clear
and enforcing the existing minimum seal-module size. Later footer pages retain
the **Verify at qred.org** caption without repeating the navigation QR. The
caption sits beside the codes where space permits, otherwise above them.

**Automatic**, the default **Page layout**, tries pale watermarks first on each
text page and falls back to a clear footer only on pages where they cannot be
placed or recovered. The explicit **Pale watermark (experimental)** option uses
the same behavior; footer layouts can also be selected directly.
Watermarks preserve the original paper
dimensions, text size, rotation, and crop on pages where watermarks are readable. An optional half-inch conventional QR opens
`https://qred.org/` from a clear area on the first page; pale QR watermarks carry
each page's signed data. The watermark uses 15% black with multiply blending to
keep the pattern pale and document text intact. Use QRed's camera or image picker
to read the watermarks.
The navigation code contains no document data and is ignored during verification.
Placement checks rendered pixels, including graphics, before using a blank area.
Text pages with embedded logos or pictures are eligible for watermarks; the
rendered recovery check determines whether the seal remains readable.
QRed first tries the full-page rectangular layout when its modules meet the
minimum printed size. It checks exact payload recovery from a clean render and
a softened/shaded simulation. If that fails, a rendered obstruction map helps
select a smaller square fallback, which must also pass recovery checks.
The navigation panel may cover watermark modules, but must avoid original page
marks and preserve its own quiet zone. Both the link and every signed chunk
must remain readable. If the link cannot fit, QRed tries a text-only
**Verify at qred.org** instruction before falling back to a footer.
Image-only and blank pages automatically use a clear footer. A page also falls back
to a footer if neither navigation nor its text instruction can fit safely, its watermark is too dense, or
QRed cannot recover it from the rendered output. Other pages retain their watermark
layout. Footer fallback expands letter pages to legal size and shrinks other page
contents to make room; the completion message lists the affected pages.

Watermark recovery uses QR module geometry to sample pale neutral-gray ink
around dark or colored foreground text, with uncertain pixels excluded from
the decision. The page can carry up to four conventional QR symbols, in a
2×2 watermark layout where space permits. See [watermark decoding](docs/WATERMARK_DECODING.md).
In experimental watermark mode, QRed uses page-filling rectangular QR
modules, page-corner perspective correction, and virtual quiet zones. Ordinary
QR decoding remains a fallback for square layouts and close-up photographs.
This preserves optical layout support, not support for retired padding-format payloads.
[Readability requirements and acceptance tests](docs/WATERMARK_READABILITY_REQUIREMENTS.md)
remain the release gate, and **physical 150/300/600-DPI print/phone verification
is not yet established**. Recovered data still requires the same
cryptographic signature verification. Digital rendering tests cover opaque white
backgrounds, text overlap, multiple pages/chunks, and both PDF.js and Poppler.
They do not establish print-camera reliability. Test a printed copy before
sharing: pictures, bold text, lighting, grayscale printing, and photocopying can
destroy information in a pale watermark.

Each seal uses the smallest QR grid that fits its actual payload, then the
strongest error correction that fits that grid. Smaller payloads therefore
produce fewer, larger modules within the same printed square. This favors
module size over adding error correction that would require a larger grid;
callers can still pin a correction level when needed.

When a page needs multiple codes, QRed keeps the minimum code count and balances
the complete payloads, including the first code's signature, to reduce the
largest grid. If balancing cannot reduce it, the original split is retained
so a smaller final code does not grow unnecessarily. Printed sizes stay the same.

Both camera views prefer the rear main camera at 1× and show a page-shaped guide;
keep all four page corners visible and avoid glare. Lens selection depends on
what the browser exposes. There is no flashlight control.
Live scanning uses a background worker with one frame in flight and no queued
frames. It rotates through bounded attempts and disables lengthy alignment
refinement so the operator can adjust the camera. Selected images and
**Capture page** use a cancellable worker with longer recovery fallbacks.
A fast bounded attempt comes first; original-resolution pixels remain available
for harder pages. **Cancel and resume camera** returns from still-photo recovery
to the same camera stream. Signature verification still checks the recovered
signed payload and trusted key.

Start the camera once, then move between seals. It stays open while QR pieces or
PDF pages are missing, ignores repeated scans, and stops when the expected pages
are collected (or verification fails). Progress shows the current page's QR count
or the document's page count. Any piece identifies its page's chunk count; a split
page must be reconstructed before its document page count is available. Counts
from unverified signatures are labeled as unverified. Different document roots,
keys, timestamps, or page counts are kept separate. Use **Close** to pause scanning
or **Clear collected seals** to start a fresh collection on the homepage.

Choose **Open PDF to verify** on the homepage or `verify.htm` to read seals from
every visible PDF page, including multiple QR parts on one page and pale
watermarks. QRed renders and scans the file locally, retains page images for
comparison, and uses the same signature checks as camera scans. Progress is
shown page by page; **Stop reading PDF** keeps seals already found. Opening
another PDF continues the collection. The completion message lists pages with
no readable seal or an unfinished scan. A valid seal authenticates its signed
contents, not every visible mark on the loaded PDF; compare the page below.

Choose **Private key file (offline)** to reuse a local signing identity. Open its `.txt` file or paste the private key; QRed derives the public key automatically. There is no separate public-key entry or derive button in the sealing form. You can still save the public key or select **Use public key to verify** on the same device. After scanning a locally signed seal, the verifier offers **Open issuer public key file** and rechecks collected seals when a key is imported. Obtain this file from the issuer through a trusted channel. Invalid files leave existing keys intact, and replacing a private key asks for confirmation.

The **Stamp PDF** button in the QR scanner opens the PDF stamping section, scrolls to it and moves focus to the heading. In the stamping tool, choose **Private key (offline)** or one of the three individual **Authenticate with Google/Microsoft/Amazon login** buttons (not a dropdown). The selected method is highlighted, and methods confirmed unavailable are disabled. Selecting an account method and a PDF automatically prepares the PDF locally; choosing a method alone does not authenticate or upload anything.

QRed automatically prepares the PDF in the original browser tab. Once the document-specific short-lived account session is ready, the provider sign-in button appears. This avoids a blank `about:blank` popup while the original browser tab processes the PDF. Google and Microsoft use a native `<a target="_blank" rel="noopener noreferrer">` link to their verified sign-in URLs. Amazon first tries direct `window.open(finalUrl)` on the same user tap, then synchronously clears the new tab's `opener` before external content can load. If the browser blocks it, Amazon falls back to the native link. No provider pre-opens a blank popup while QRed prepares the PDF or uses delayed navigation. On phones, return to the original QRed tab after authenticating to finish the PDF; keep that tab open and do not navigate away. The prepared session expires after five minutes, and cancellation attempts to clear the encrypted session cookies. After the provider opens, **Check sign-in status** on the original tab can verify a pending, failed, or completed Worker session if the browser silently closed the provider tab. A successful Google or Amazon callback attempts to close its sign-in tab without requiring a window opener. If the browser blocks closure, use the callback's close button or switch back to the original QRed tab; never reload the original page. A failed sign-in callback stays visible with a sanitized reason. If the callback shows success but the original tab stays pending, the PDF is **not yet sealed**, and browser cookie isolation or another session handoff problem needs investigation. The PDF stays on the device; only unsalted page commitments are sent to the Worker.

When configured, **Google**, **Microsoft**, and **Amazon** sign-in let QRed attest the prepared document, provider account, profile name/email, and server time. Google retains its Gmail/Workspace eligibility rule. For the other providers, verifiers identify the email as provider-reported, not independently verified mailbox control. Each method uses encrypted, short-lived browser cookies without a database. Each document requires a connection to obtain its attestation; scanning works offline with the trusted authority keys built into the verifier. Providers are enabled independently: Microsoft uses a public SPA client ID with browser PKCE (no expiring client secret), while Google and Amazon require server-side secrets. [Setup, protocol and privacy details](docs/ACCOUNT_ATTESTATION.md).

There is no public-key text field in the verifier. Account seals select a bundled trusted authority key automatically using the key ID in the QR payload, so their verification needs no key-file import. An unknown authority remains unverified; a key supplied by the QR itself would not establish trust.

Key files contain one raw key as Base64URL or standard Base64, with or without padding. Surrounding whitespace and a UTF-8 BOM are accepted; files larger than 4 KB are rejected. The private key is a raw 32-byte Ed25519 seed; the public key is a raw 32-byte Ed25519 public key (43 encoded characters, optionally followed by `=`). PEM, SSH, hex, and expanded 64-byte private keys are not accepted. Because raw private and public keys have the same encoding, use the appropriate file control; QRed catches swapped files when they retain its saved filenames. For the private-key method, key generation, file reading, derivation, validation, and signing happen locally; user keys are never sent to a server or saved in browser storage.

The configured/default public key is for verification only. The stamping tool does not preload it because an unrelated private key cannot sign for it. A generated key proves control of that signing key, not an independently verified issuer identity.

## Check a printed document

On the homepage or `verify.htm`, choose **Check document** and allow camera access.
QRed prepares its local English text reader before opening the camera. Frame each
whole page upright, in good light. The same temporary frame is used for seal
recovery and printed-text comparison; no photograph needs to be saved or selected
from the phone's gallery. Use **Capture page** on the homepage if live recovery
needs a longer still-image attempt.

After collection, every captured page with authenticated signed text is checked
automatically, one at a time. **Review captured pages** stops scanning and checks a
partial collection without requiring the rest of the document. Other pages remain
explicitly unchecked. Page buttons retain their individual results, and the first
reading that needs review opens automatically. A valid seal is labelled **Seal
authenticated**, separately from the printed-text result.

Differences show the signed wording, the independently recognized wording, and a
magnified photo region where a reliable location is available. Red highlights mark
different/extra readings; amber marks uncertainty. Matching-word highlights are
optional. Missing text is listed without inventing a photo location. **Retake this
page** uses QRed's browser camera and replaces the superseded capture and result.

This is OCR-assisted text comparison, not authentication of every pixel,
handwriting, images, or layout. OCR can miss or misread text, even confidently.
Check important numbers and unmarked areas. Blur, skew, columns, watermark seals,
and QRed's added captions can produce differences. Case, punctuation, numbers,
signs, and repeated words are preserved; only whitespace and canonical Unicode
composition are ignored. The reader never receives the signed text as a recognition
hint. Confidence is a review heuristic, not a probability of authenticity.

**Compare the signed visual reference** opens the optional lossy grayscale
reference and signed line locations for manual inspection. Image-only and blank
pages do not receive an automatic image-match verdict. Fine details, colors,
handwriting, and face substitutions may be lost in the reference. Retakes use the
same temporary browser-camera flow. Existing PDF and image inputs remain available
as secondary entry points.

**Finish & clear** ends the check, stops the camera and OCR worker, revokes image
URLs, and releases captured images, recognized words, signed contents, and results.
Late asynchronous results cannot restore a cleared check. Navigating away also
ends the check; refreshing does not restore document history. Start another check
from the cleared screen. QRed does not upload this data, save it to the photo
library, or write it to persistent browser storage. This is application-level
cleanup, not a promise of forensic erasure from the browser or operating system.

Only public application resources and the English OCR model are cached for offline
use. **Prepare for offline checking** can preload the text reader before entering
airplane mode or opening an existing file. Keep the tab open. Captures are bounded
to one image per page, 16 images / 32 MiB total, with four encodings in flight and
six megapixels per image. Evicted images are explicitly marked as needing a new
capture. Synthetic tests cover changed words on page 2, retakes, partial collection,
clear/cancellation races, and network/persistent-storage behavior. Physical phone
and printer trials remain necessary for optical accuracy and usability.

## Run tests

```bash
cd frontend
npm ci
npm run lint
npm test          # Unit tests and rendered PDF regressions
npm run build
npm exec vite preview -- --host 127.0.0.1 --port 3000
# In another terminal, from the repository root:
pip install -r requirements.txt
python -m playwright install chromium
QRED_BASE_URL=http://localhost:3000 pytest -v
```

With the production build served at `QRED_BASE_URL` (default `http://localhost:3000`),
`tests/test_network_privacy.py` checks both a connected browser with outgoing
requests blocked and a browser set offline. It keeps the real service worker
enabled, warms PDF resources with a disposable document, then requires zero
HTTP or WebSocket attempts while generating/opening/saving keys, stamping
and saving a PDF, and verifying seal text and QR image pixels. Loading permits
only same-origin GETs for known build files and the default public key. Probe
requests verify that the guard catches page and service-worker traffic.
`tests/test_photo_verification.py` additionally loads the real English OCR engine,
then compares matching, altered, incomplete, and blank synthetic page images on
both verifier routes with networking blocked or offline. It checks highlighted
image coordinates and rejects missing model resources with a recoverable error.
This covers the tested workflows after their resources load; first-use assets,
page reloads, and device-wide traffic are outside that assertion.

All committed regression cases run by default. Required files and dependencies
must be present; there are no optional temporary-path tests. The
[fixture guide](tests/fixtures/README.md) maps the former skipped cases to their
active replacements and records JPEG provenance. Real print/camera validation
still needs a documented physical capture; simulated JPEG compression is tested
separately.

## Shared workflow modules

- `sealFormat.js` defines binary envelope sizes; `sealBudget.js` owns QR capacity
  and the four-code PDF limit. Evidence planning and final sealing use the same
  compression selection in `sealCompression.js`.
- `pdfClientSeal.js` prepares and signs page evidence. `pdf/renderSealedPdf.js`
  places completed seals and checks watermark recovery, retrying with footers
  without changing or signing the page evidence again.
- `verifier/verificationSession.js` owns collected seals, verification revisions,
  ordering and progress for both verifier screens. Resetting, adding seals, or
  starting a new key check invalidates older asynchronous results.
- `qr/cameraSession.js` owns stream cleanup and the throttled decode loop, including
  camera requests that resolve after scanning has stopped.
- `tests/browser_helpers.py` provides real production download checks, offline
  resource readiness and the HTTP/WebSocket guard. Browser tests use synthetic
  documents and ordinary pytest discovery; no retired Python backend is needed.

## Deploy to Cloudflare

```bash
cd frontend
npm run build:pages
```

The build outputs static assets to `frontend/build/` and copies the Worker to `frontend/build/_worker.js`. Deploy the `build` directory as a Cloudflare Pages project.


# Production deployment for qred.org

The production verifier is expected to be served by Cloudflare Pages at `https://qred.org/verify.htm`. The repository root now includes Cloudflare Pages config and npm build scripts so Cloudflare can publish the frontend even when the project is connected from the repository root. Do not use GoDaddy URL forwarding as the primary production mechanism: forwarding can change the browser-visible URL, introduce redirect dependencies, and does not prove that `/verify.htm` is being served directly by the Cloudflare Pages deployment with Cloudflare-managed TLS.

## Cloudflare Pages build settings

Configure the Cloudflare Pages project with these settings:

| Setting | Value |
| --- | --- |
| Project root / root directory | `frontend` |
| Build command | `npm ci && npm run build:pages` |
| Build output directory | `build` |
| Deploy command, if the Cloudflare UI requires one | `npm ci && npm run build:pages` |
| Production URL expectation | `https://qred.org/verify.htm` |

Use `npm ci && npm run build:pages` after setting the project root to `frontend`, where `package.json` and `package-lock.json` live. The `build:pages` script builds the static frontend and copies `frontend/worker/index.js` to `build/_worker.js`, which is required for Cloudflare Pages to run the `/api/*` Worker routes in production. If Cloudflare runs from the repository root, use the root `npm run build` script and publish `frontend/build`; the root `wrangler.jsonc` declares that Pages output directory. If the UI requires manual settings instead, use `cd frontend && npm ci && npm run build:pages` and set the build output directory to `frontend/build`.

The frontend supports Cloudflare Pages or Workers with static assets. `frontend/worker/index.js` serves the public-key API and optional account authentication/attestation endpoints. PDF processing and QR generation stay in the browser. Local signatures use user-held keys; Account attestations use a separate QRed authority secret in the Worker. The server never returns that secret or receives user private keys. Each account provider remains disabled until its [configuration](docs/ACCOUNT_ATTESTATION.md) is complete.

Optional Worker variables for a custom public key are:

| Variable | Purpose |
| --- | --- |
| `QRED_DEFAULT_PUBLIC_KEY` | Base64URL-encoded Ed25519 public key. |
| `QRED_DEFAULT_KEY_ID` | Optional key ID. If omitted, the Worker derives it from `QRED_DEFAULT_PUBLIC_KEY`. |

Local signers generate a pair in the browser or open their private key file. Account signers authenticate with a configured provider instead; the Worker signs using its dedicated authority secret.

## Cloudflare Pages custom domains

1. Open the Cloudflare Pages project that builds and deploys the QRed verifier.
2. Add `qred.org` as a Pages custom domain. This is the required apex production hostname.
3. Add `www.qred.org` as an additional Pages custom domain if the site should support both the apex domain and `www`.
4. Wait for Cloudflare Pages to show the custom domain as active and for the TLS certificate status to become valid before publishing QR codes that point at the hostname.

## DNS configuration

Use one of these DNS approaches; prefer Cloudflare nameserver delegation when possible.

### Recommended: delegate DNS to Cloudflare

1. In Cloudflare, add `qred.org` as a zone if it is not already present.
2. Copy the two Cloudflare nameservers assigned to the zone.
3. In GoDaddy, replace the domain's existing nameservers with the Cloudflare nameservers. Do not configure GoDaddy domain forwarding for production traffic.
4. In the Cloudflare zone, let Cloudflare Pages create the required records for the Pages custom domains, or create the records Cloudflare Pages requests during custom-domain setup.
5. Confirm that `qred.org` and, if enabled, `www.qred.org` are proxied through Cloudflare and attached to the Pages project.

### Alternative: keep DNS at GoDaddy

If the domain must continue using GoDaddy DNS, do not use GoDaddy forwarding as the main deployment path. Instead, create the exact DNS records that Cloudflare Pages displays during custom-domain setup. Cloudflare Pages commonly asks for a CNAME for a subdomain such as `www.qred.org`; apex-domain requirements can vary by account and Cloudflare setup, so use the current values shown in the Pages custom-domain wizard rather than guessing.

After records are created in GoDaddy, return to Cloudflare Pages and verify that both the DNS check and the certificate issuance check pass for every configured custom domain.

## Post-deploy smoke test checklist

Before considering production deployment complete, verify all of the following:

- The homepage loads successfully at `https://qred.org/`.
- The verifier route loads successfully at `https://qred.org/verify.htm`.
- The scanner recovers binary seal messages from QR images, collects all chunks, and verifies locally against the selected issuer public key.
- Generated payload QR codes contain standard binary messages. QRed interprets those bytes as signed document records; separate navigation codes open `https://qred.org/`.

A quick HTTP check for the required verifier route is:

```bash
curl -I https://qred.org/verify.htm
```

The response should resolve directly on `https://qred.org/verify.htm`, present a valid TLS certificate, and return a successful HTTP status from the Cloudflare Pages deployment. If `www.qred.org` is enabled, also verify the intended `www` behavior, for example:

```bash
curl -I https://www.qred.org/verify.htm
```

## Bootstrap URL and verifier route

QRed payload QR codes encode only the binary seal record in a standard byte segment, with ordinary terminator and padding bytes. They do not contain a bootstrap URL or data hidden after the terminator. A separate navigation QR opens `https://qred.org/` from the first page, in its footer when using footer seals or on its watermark when space and recovery permit; every sealed page retains the printed “Verify at QRED.ORG” instruction. The `/verify.htm` path remains a human-facing verifier route. Retired padding-format QR images must be re-sealed; deploy the stamper and all verifier routes together and refresh saved offline copies.

# Motivation

Many documents are distributed in printed form and may be photocopied, scanned, emailed, faxed, or manually altered. While digital signatures are well understood in electronic documents, there is no widely adopted method for making printed documents self-verifying.

QRed bridges the gap between physical and digital documents by embedding a signed representation of the document directly on the page.

Recipients can check the signature on the embedded evidence using a trusted
key, then compare that evidence with the visible document. A valid signature
alone does not establish that the paper matches the evidence or that the signer
has legal identity or organizational authority.

# How It Works

1. The browser extracts canonical text and optional page evidence, or creates a visual/blank-page reference when no text is available.
2. A local Ed25519 key signs the evidence and metadata, or an online account attestation binds a page commitment to provider identity and server time.
3. Automatic encoding compares plaintext with zlib, choosing fewer QR codes and then fewer payload bytes; gzip is a fallback. Compression is reversible, not encryption.
4. The binary record is placed in ordinary QR byte segments, split into numbered chunks when needed. Printed seals contain no document URL or hidden padding data.
5. A separate first-page navigation QR is required in footer layouts and optional on watermarks. Every page retains the printed verifier address.
6. The recipient opens qred.org and reads the seals with its camera, photo or PDF scanner.
7. The verifier reconstructs the record, decompresses it when needed and checks the signature against a trusted key.
8. The recipient compares recovered signed text and visual evidence with the document. OCR assists this comparison but does not authenticate every visible detail.

# Design Goals

- No dedicated mobile application required.
- Works with standard smartphone cameras.
- Offline verification after payload acquisition.
- Open and interoperable format.
- Resistant to casual document tampering.
- Supports multi-page and high-content documents.
- Binds sealed PDF pages with signed page positions and a shared document Merkle root so swapped-in pages can be detected.
- Support evaluation for records workflows without claiming regulatory approval or suitability for a particular organization.

# Non-Goals

QRed is not intended to:

- Replace PKI infrastructure.
- Guarantee document authenticity without a trusted issuer.
- Prevent unauthorized copying of documents.
- Encrypt embedded contents or prevent anyone with a copy from decoding them.

# Example Use Cases

These are possible evaluation scenarios, not endorsements for regulated use:

- Criminal history reports
- Background check summaries
- Licenses and certifications
- Academic transcripts
- Court documents
- Employment verification letters
- Insurance documents
- Government notices

# Architecture

A typical QRed document contains:

- A separate navigation QR on the first page where supported, plus a printed verifier address
- One or more payload QR codes
- A digitally signed document payload

The navigation QR launches the verifier web application and contains no document data.

A standard QR decoder can recover the binary seal message. QRed interprets that message to reconstruct and verify the document; generic camera apps may not display binary data usefully. Use the separate navigation code or printed qred.org address to open the verifier.

# Security Model

QRed relies on public key cryptography.

Each issuing authority maintains a signing key pair:

- Private key: used to sign document payloads. Must be generated and stored securely by the issuer — never uploaded to any server.
- Public key: used by the verifier to validate signatures. This is the only key that may be served from the server (e.g., via `/api/keys/default`).

**User private keys and original document contents stay on the device.** Local signing and verification work offline after resources are loaded. Optional account sealing sends deterministic, unsalted page commitments and account details to QRed; these commitments are document-related metadata, not anonymized data. The server holds its own authority signing key as a secret and never sends it to clients. Its public trust anchors are bundled in the verifier; unknown account-attestation authorities remain unverified. See [the attestation privacy and trust model](docs/ACCOUNT_ATTESTATION.md).

Public demo keys in test fixtures prove no issuer identity. The stamping tool does
not preload a demo private key. Generate or import your own key, or choose a
configured account provider.

Changing signed content or authenticated v3/v4 metadata invalidates the signature. A
recipient must also compare that recovered text with the visible document;
changing the paper while leaving its QR unchanged does not alter the QR's
signature. Optional visual references and line coordinates are authenticated as
stored, but they are lossy evidence, not a guarantee of exact page appearance.
Critical image details and photo substitutions may not be distinguishable.

# Status

QRed is currently an experimental specification and reference implementation.

The format, payload structure, chunking rules, compression algorithms, and verification workflow may evolve as the project matures. See [the compression transport specification](docs/GZIP_SEALS.md) for the current binary framing, size limits, and deployment requirements.

# License

This project's source code is released under [Apache License 2.0](LICENSE).
Dependencies retain their own licenses. The contributor patent grant is limited
to covered claims those contributors can license; it is not blanket permission
from unrelated patent holders.

Ordinary QR byte encoding does not make the experimental rectangular watermark
geometry JIS/ISO conformant. QRed does not claim patent clearance or separate
DENSO permission for those variations. See [licensing and QR compatibility](docs/LICENSING_AND_COMPATIBILITY.md),
the [Privacy Policy](https://qred.org/privacy.html), [Terms](https://qred.org/terms.html),
and [Security & architecture](https://qred.org/security.html).
