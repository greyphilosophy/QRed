# QRed

QRed is an open standard and reference implementation for tamper-evident document sealing and verification.

QRed encodes the signed contents of a document into one or more QR code seals printed alongside the document. A normal smartphone camera scan of a payload QR only opens the visible bootstrap URL; the hidden signed payload is recovered later by the QRed verifier using its own camera/image scanner to read the QR image itself.

No app installation is required.

Local seals use compact v3 binary records with signed text, timestamp, key ID,
and page context. Issuer names are omitted. Older seals must be re-sealed.
Image-only pages carry a signed grayscale visual reference; blank pages carry an
explicit signed blank-page marker. Text pages use spare capacity for line positions
and an approximate visual reference, without adding QR codes. Experimental
watermark mode uses one page-filling QR or splits overflow into four balanced
quadrant QRs. Explicit footer mode retains ordinary QR counts up to four. See [page references](docs/PAGE_REFERENCES.md) and
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

The demo app runs at `http://localhost:3000`. Local private-key sealing and QR processing run in the browser without a backend. Optional account sealing uses a Cloudflare Worker to attest randomized document fingerprints; PDFs and document text stay on the device. See [account sign-in setup](docs/ACCOUNT_ATTESTATION.md).

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
that same footer. The caption sits beside the codes where space permits.

**Automatic**, the default **Page layout**, tries pale watermarks first on each
text page and falls back to a clear footer only on pages where they cannot be
placed or recovered. The explicit **Pale watermark (experimental)** option uses
the same behavior; footer layouts can also be selected directly.
Watermarks preserve the original paper
dimensions, text size, rotation, and crop on pages where watermarks are readable. A half-inch conventional QR opens
`https://qred.org/` from a clear area on the first page; pale QR watermarks carry
each page's signed data. The watermark uses 15% black with multiply blending to
keep the pattern pale and document text intact. Use QRed's camera or image picker
to read the watermarks.
The navigation code contains no document data and is ignored during verification.
Placement checks rendered pixels, including graphics, before using a blank area.
Text pages with embedded logos or pictures are eligible for watermarks; the
rendered recovery check determines whether the seal remains readable.
Before drawing, QRed analyzes the original page for broad dark areas and gray
graphics that could interfere with scanning. It selects a position and size
from that obstruction map, giving extra weight to the QR's finder patterns,
timing strips, lower-right alignment pattern, and quiet zone while favoring
larger printed modules. Thin black text is treated as easier to recover around.
This is a bounded geometric optimization, not a sequence of trial stamps or
decodes. It predicts readability; it does not guarantee the best possible
placement. The selected watermark must still pass the rendered recovery check.
Image-only and blank pages automatically use a clear footer. A page also falls back
to a footer if there is no clear entry-code space, its watermark is too dense, or
QRed cannot recover it from the rendered output. Other pages retain their watermark
layout. Footer fallback expands letter pages to legal size and shrinks other page
contents to make room; the completion message lists the affected pages.

Watermark recovery uses QR module geometry to sample pale neutral-gray ink
around dark or colored foreground text, with uncertain pixels excluded from
the decision. The page can carry up to four conventional QR symbols, in a
2×2 watermark layout where space permits. See [watermark decoding](docs/WATERMARK_DECODING.md).
In experimental watermark mode, QRed uses page-filling rectangular QR
modules, page-corner perspective correction, and virtual quiet zones. Ordinary
QR decoding remains a fallback for old seals and close-up photographs.
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

The image and camera scanners retry failed detections at a few nearby image
scales to handle dense QR codes whose edges fall between pixels. Live camera
scanning tries one scale per frame, with time for input and rendering between
attempts. Chosen images and manual photo captures try all scales immediately.
Signature verification still uses the recovered signed payload and the issuer's key.

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

The **Stamp PDF** button in the QR scanner opens the PDF stamping section, scrolls to it and moves focus to the heading. In the stamping tool, choose **Private key (offline)** or one of the three individual **Authenticate with Google/Microsoft/Amazon login** buttons (not a dropdown). The selected method is highlighted, and methods confirmed unavailable are disabled. Selecting an account method and a PDF automatically prepares the PDF locally; choosing a method alone does not authenticate or upload anything.\n\nQRed automatically prepares the PDF in the original browser tab. Once the document-specific short-lived account session is ready, the provider sign-in button appears. This avoids a blank `about:blank` popup while the original browser tab processes the PDF. Google and Microsoft use a native `<a target="_blank" rel="noopener noreferrer">` link to their verified sign-in URLs. Amazon first tries direct `window.open(finalUrl)` on the same user tap, then synchronously clears the new tab's `opener` before external content can load. If the browser blocks it, Amazon falls back to the native link. No provider pre-opens a blank popup while QRed prepares the PDF or uses delayed navigation. On phones, return to the original QRed tab after authenticating to finish the PDF; keep that tab open and do not navigate away. The prepared session expires after five minutes, and cancellation attempts to clear the encrypted session cookies. After the provider opens, **Check sign-in status** on the original tab can verify a pending, failed, or completed Worker session if the browser silently closed the provider tab. A successful Google or Amazon callback attempts to close its sign-in tab without requiring a window opener. If the browser blocks closure, use the callback's close button or switch back to the original QRed tab; never reload the original page. A failed sign-in callback stays visible with a sanitized reason. If the callback shows success but the original tab stays pending, the PDF is **not yet sealed**, and browser cookie isolation or another session handoff problem needs investigation. The PDF and its page salts never leave the device.\n\nWhen configured, **Google**, **Microsoft**, and **Amazon** sign-in let QRed attest the prepared document, provider account, profile name/email, and server time. Google retains its Gmail/Workspace eligibility rule. For the other providers, verifiers identify the email as provider-reported, not independently verified mailbox control. Each method uses encrypted, short-lived browser cookies without a database. Each document requires a connection to obtain its attestation; scanning works offline with the trusted authority keys built into the verifier. Providers are enabled independently: Microsoft uses a public SPA client ID with browser PKCE (no expiring client secret), while Google and Amazon require server-side secrets. [Setup, protocol and privacy details](docs/ACCOUNT_ATTESTATION.md).

There is no public-key text field in the verifier. Account seals select a bundled trusted authority key automatically using the key ID in the QR payload, so their verification needs no key-file import. An unknown authority remains unverified; a key supplied by the QR itself would not establish trust.

Key files contain one raw key as Base64URL or standard Base64, with or without padding. Surrounding whitespace and a UTF-8 BOM are accepted; files larger than 4 KB are rejected. The private key is a raw 32-byte Ed25519 seed; the public key is a raw 32-byte Ed25519 public key (43 encoded characters, optionally followed by `=`). PEM, SSH, hex, and expanded 64-byte private keys are not accepted. Because raw private and public keys have the same encoding, use the appropriate file control; QRed catches swapped files when they retain its saved filenames. For the private-key method, key generation, file reading, derivation, validation, and signing happen locally; user keys are never sent to a server or saved in browser storage.

The configured/default public key is for verification only. The stamping tool does not preload it because an unrelated private key cannot sign for it. A generated key proves control of that signing key, not an independently verified issuer identity.

## Compare a printed page photo

**Signed page reference** reconstructs the optional grayscale thumbnail from the
seal, offline, beside a captured or uploaded page photo. **Locate signed text**
highlights the recorded line location when present. Image-only pages need no OCR
model download; blank pages display the signed blank-page marker. These views
support manual comparison, not an automatic image-match verdict. Lossy references
can miss small changes, colors, digits, handwriting, and face substitutions.


After verifying a page's seals, use **Compare a page photo** on the homepage or
`verify.htm`. A successful seal scan also retains its original image, including
when reading a pale watermark. Once the seals are verified and collection has
finished, the selected page's image is compared automatically if text recognition
is loaded. You can load the reader after scanning too; the image waits in this tab.
For multi-seal pages, **Captured scan image** lets you choose among the images.
Pages and images are associated by seal identifiers, even when scanned out of order.

Include the entire page upright and in good light. Reading a QR does not establish
that the rest of the page is in focus or even in frame. You can always take or
choose a clearer page photo. For a multi-page collection, select the signed page
to review. Existing seals work without adding any payload bytes.

QRed reads printed English text locally and highlights the same still image:
green for matching words, red for different/extra readings, amber for uncertain
readings. Tap a highlight to see what was read; zoom or rotate the photo as needed.
Missing signed text appears in a separate review list because seals contain no
word coordinates. Choosing another page, clearing the collection, or invalidating
the signature discards the previous photo comparison.

This is an OCR-assisted text comparison, not authentication of every pixel,
handwriting, images, or layout. OCR can miss or misread text, even confidently.
Check important numbers and unmarked areas. Blur, skew, columns, watermark seals,
and QRed's added seal captions can produce differences. Case, punctuation,
numbers, signs, and repeated words are preserved; only whitespace and canonical
Unicode composition are ignored. The reader never receives the expected text as
a recognition hint. Its confidence threshold is a review heuristic, not an
authenticity probability.

The English model, WebAssembly engine, and worker are served by QRed itself and
cached as versioned assets. **Text recognition ready** means the reader is loaded
in the current tab and can process photos offline. Photos and recognized text
are kept only in memory, not uploaded or written to browser storage. Reloading
or clearing the seal collection releases the captured scan images. Capture is
deduplicated per seal and bounded to 16 images / 32 MiB of encoded images, with
at most four encodings in flight. Older images are released with a notice if the
limit is reached; retained images are capped at six megapixels. Reloading
or clearing browser caches may require loading resources again. The first release
is covered by synthetic-image browser tests; physical print/phone-camera accuracy
still needs testing.

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
  and the two-code PDF limit. Evidence planning and final sealing use the same
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
- The scanner recovers hidden payloads from QR images, collects all chunks, and verifies locally against the selected issuer public key.
- Generated QRed payload QR codes in sealed PDFs and API responses show `https://qred.org/` to ordinary scanners, and only the QRed-aware scanner can recover the signed payload data hidden in QR codewords.

A quick HTTP check for the required verifier route is:

```bash
curl -I https://qred.org/verify.htm
```

The response should resolve directly on `https://qred.org/verify.htm`, present a valid TLS certificate, and return a successful HTTP status from the Cloudflare Pages deployment. If `www.qred.org` is enabled, also verify the intended `www` behavior, for example:

```bash
curl -I https://www.qred.org/verify.htm
```

## Bootstrap URL and verifier route

New QRed-generated payload QR codes use `https://qred.org/` as the visible bootstrap URL. Ordinary camera apps pass only that URL to the browser; they do not pass the hidden payload. The signed payload is hidden in QR codewords and is recoverable only when the QRed verifier scans the QR image itself, so it must not be described as a URL marker or fragment. The `/verify.htm` path is retained only as the human-facing verifier route. If the verifier application is reorganized, either keep this route serving the verifier or update the production deployment documentation at the same time.

# Motivation

Many documents are distributed in printed form and may be photocopied, scanned, emailed, faxed, or manually altered. While digital signatures are well understood in electronic documents, there is no widely adopted method for making printed documents self-verifying.

QRed bridges the gap between physical and digital documents by embedding a signed representation of the document directly on the page.

This allows recipients to verify:

- The document was issued by the certifying authority.
- The certified contents have not been altered.
- The displayed contents match the original signed document.

# How It Works

1. A document is converted into a canonical text representation.
3. The canonical text is digitally signed by the issuing authority.
4. Automatic encoding compares plaintext with zlib-compressed UTF-8 text, choosing fewer QR codes and then fewer payload bytes. Short text stays uncompressed when that is smaller. Zlib saves 12 wrapper bytes per compressed page compared with gzip. Gzip remains readable and is used as a fallback if zlib compression is unavailable. Compressed bytes are stored directly in the hidden QR carrier; Base64URL is only used for copying seal strings into the verifier.
5. The chosen payload format is divided into one or more QR code seals.
6. A bootstrap QR code containing a URL to a verifier web application is added to the document.
7. The QR seals are printed alongside the document.
8. A recipient scans the bootstrap QR code.
9. The verifier web application scans the remaining QR seals.
10. The verifier joins the chunks, decompresses zlib/gzip when selected, and verifies the signature against the exact restored text and signed metadata.
11. The certified contents are displayed to the user.

# Design Goals

- No dedicated mobile application required.
- Works with standard smartphone cameras.
- Offline verification after payload acquisition.
- Open and interoperable format.
- Resistant to casual document tampering.
- Supports multi-page and high-content documents.
- Binds sealed PDF pages with signed page positions and a shared document Merkle root so swapped-in pages can be detected.
- Suitable for government, legal, educational, and business records.

# Non-Goals

QRed is not intended to:

- Replace PKI infrastructure.
- Guarantee document authenticity without a trusted issuer.
- Prevent unauthorized copying of documents.
- Protect confidential information from authorized viewers.

# Example Use Cases

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

- One bootstrap QR code
- One or more payload QR codes
- A digitally signed document payload

The bootstrap QR launches the verifier web application.

The payload QR codes visibly scan as the bootstrap URL in ordinary camera apps. The signed document data required to reconstruct and validate the certified contents is hidden in QR codewords and is available only to a QRed-aware scanner that reads the QR image itself.

# Security Model

QRed relies on public key cryptography.

Each issuing authority maintains a signing key pair:

- Private key: used to sign document payloads. Must be generated and stored securely by the issuer — never uploaded to any server.
- Public key: used by the verifier to validate signatures. This is the only key that may be served from the server (e.g., via `/api/keys/default`).

**User private keys and document contents stay on the device.** Local signing and verification work offline after resources are loaded. Optional account sealing sends randomized page commitments and account details to QRed. The server holds its own authority signing key as a secret and never sends it to clients. Its public trust anchors are bundled in the verifier; unknown account-attestation authorities remain unverified. See [the attestation privacy and trust model](docs/ACCOUNT_ATTESTATION.md).

The default demo keypair is provided solely for testing. In production, issuers should generate their own keypair and supply the private key directly in the browser.

Changing signed text or v2 identity metadata invalidates the signature. A
recipient must also compare that recovered text with the visible document;
changing the paper while leaving its QR unchanged does not alter the QR's
signature. Optional visual references and line coordinates are authenticated as
stored, but they are lossy evidence, not a guarantee of exact page appearance.
Critical image details and photo substitutions may not be distinguishable.

# Status

QRed is currently an experimental specification and reference implementation.

The format, payload structure, chunking rules, compression algorithms, and verification workflow may evolve as the project matures. See [the compression transport specification](docs/GZIP_SEALS.md) for the current binary framing, size limits, and deployment requirements.

# License

This project is released under the Apache License 2.0.
