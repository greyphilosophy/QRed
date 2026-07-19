# QRed

QRed is an open standard and reference implementation for tamper-evident document sealing and verification.

QRed encodes the signed contents of a document into one or more QR code seals printed alongside the document. A normal smartphone camera scan of a payload QR only opens the visible bootstrap URL; the hidden signed payload is recovered later by the QRed verifier using its own camera/image scanner to read the QR image itself.

No app installation is required.

# Quick Start

## Run the demo

```bash
git clone https://github.com/greyphilosophy/QRed
cd QRed
cd frontend
npm ci && npm start
```

The demo app runs at `http://localhost:3000`. It is fully client-side: all PDF sealing, QR generation, and signature operations happen in your browser. No backend server is required.

## Start the development server

```bash
cd frontend
npm install
npm start
```

Open `http://localhost:3000` in your browser. Click "Open PDF stamping tool" to upload a PDF, provide your own Ed25519 keypair, and seal it in-browser.

## Run tests

```bash
cd frontend
npm test          # Vitest unit tests
cd ../tests
pytest            # Playwright E2E parity tests
```

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

The production frontend is a Cloudflare Pages deployment with a small Worker in `frontend/worker/index.js`. All PDF sealing, QR generation, and signature operations happen client-side in the browser. The Worker serves only static assets and the public signing key at `/api/keys/default`. No private keys are ever exposed or processed by the server.

Optional Worker variables for a custom public key are:

| Variable | Purpose |
| --- | --- |
| `QRED_DEFAULT_PUBLIC_KEY` | Base64URL-encoded Ed25519 public key. |
| `QRED_DEFAULT_KEY_ID` | Optional key ID. If omitted, the Worker derives it from `QRED_DEFAULT_PUBLIC_KEY`. |

Users must supply their own private key in the browser — the server never stores, returns, or processes private keys.

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
- The scanner page can submit collected payload seals and issuer public key data to the verification API.
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
4. The implementation chooses the smaller QR count between:
   - scanner-safe QR payloads that show only the bootstrap URL to ordinary scanners while making signed data recoverable only to a QRed-aware scanner reading the QR image, and
   - reversible recipe payloads such as `b45`.
5. The chosen payload format is divided into one or more QR code seals.
6. A bootstrap QR code containing a URL to a verifier web application is added to the document.
7. The QR seals are printed alongside the document.
8. A recipient scans the bootstrap QR code.
9. The verifier web application scans the remaining QR seals.
10. The payload is reconstructed and the signature is verified.
11. The certified contents are displayed to the user.

# Design Goals

- No dedicated mobile application required.
- Works with standard smartphone cameras.
- Offline verification after payload acquisition.
- Open and interoperable format.
- Resistant to casual document tampering.
- Supports multi-page and high-content documents.
- Binds backend-sealed PDF pages with signed page hashes and a shared document Merkle root, using root-derived QR grouping data so swapped-in pages can be detected.
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

**The QRed Cloudflare Worker never stores, processes, or returns private keys.** All sealing operations — including Ed25519 signature generation — happen entirely in the user's browser using the private key the user provides. This ensures that:

- PDFs never leave the user's machine.
- Private keys never touch the server.
- Seals made with user-provided keys cannot be forged by anyone who accesses the public key endpoint.

The default demo keypair is provided solely for testing. In production, issuers should generate their own keypair and supply the private key directly in the browser.

Any modification to the sealed document contents invalidates the signature and causes verification to fail.

# Status

QRed is currently an experimental specification and reference implementation.

The format, payload structure, chunking rules, compression algorithms, and verification workflow may evolve as the project matures.

# License

This project is released under the Apache License 2.0.
