# QRed browser demo scenarios

These describe the current Vite/Cloudflare browser application. The retired
Python/FastAPI document backend is not part of this workflow. See
[Quick start](QUICK_START.md) for setup and test commands.

## Prepare and seal a document locally

**Given** QRed's required resources are available in the browser and the user
has generated or opened a private signing key,
**when** they select a PDF and choose **Stamp and save PDF**,
**then** the browser signs each page's evidence and saves a sealed PDF without
sending the original document or key to a server.

**And** Automatic layout tries a recoverable watermark before a footer, reports
footer fallback, and rejects unreadable or over-capacity output instead of
dropping seals or adding overflow pages.

## Optionally attest an account

**Given** Google, Microsoft or Amazon is configured and the user selects it,
**when** the PDF is prepared and sign-in completes within five minutes,
**then** the Worker binds provider identity and server time to the prepared page
commitments, and the original browser tab completes the PDF locally.

**And** only derived page commitments and account/session data cross that API
boundary; commitments are unsalted and can permit correlation or content guesses.

## Open the verifier from paper

**Given** the first page has a separate navigation QR,
**when** a normal camera app reads it,
**then** it opens qred.org without carrying document data in the URL.

**If** a watermark cannot accommodate the navigation QR,
**then** the printed **Verify at qred.org** instruction still provides the address.
First-page footer layouts always include the navigation QR.

## Recover and verify evidence

**Given** the recipient reads all parts of a page through the camera, photo picker
or PDF reader,
**when** ordinary QR byte messages are reconstructed,
**then** QRed verifies them locally using a trusted local issuer key or a bundled
account authority key and displays the signed evidence.

**And** a generic decoder may recover binary bytes without displaying them
usefully. The separate navigation QR is not a document seal.

## Handle missing, untrusted or altered data

**Given** some chunks are missing, **then** the page remains incomplete.
**Given** no trusted key is available, **then** it remains unverified.
**Given** a signed record or its authenticated metadata has been altered,
**then** it cannot receive a valid signature result.

**Given** the paper has changed but its QR is intact,
**then** the signature can still verify; the recipient must compare the recovered
text and visual evidence with the page. OCR assistance is not a pixel-level guarantee.

## Keep scanning responsive

**Given** live scanning is active, **then** QRed prefers the rear main camera at
1×, shows a full-page guide and runs bounded background attempts.
**When** the user chooses **Capture photo** or opens an image,
**then** longer recovery is available with cancellation; live frames do not queue
behind that work. **Cancel and resume camera** returns to live scanning.

## Handle retired QR images

**Given** a QR stores its seal after the terminator in padding,
**when** the current verifier reads it,
**then** those bytes are not recovered as a seal. Re-seal the source document
with the current stamper and update saved offline verifier copies.
