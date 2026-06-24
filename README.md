# QRed

QRed is an open standard and reference implementation for tamper-evident document sealing and verification.

QRed encodes the signed contents of a document into one or more QR code seals printed alongside the document. Recipients can scan a bootstrap QR code using a standard smartphone camera to launch a web-based verifier that reconstructs, validates, and displays the certified contents of the document.

No app installation is required.

# Quick Start

## Run the demo

```bash
git clone https://github.com/greyphilosophy/QRed
cd QRed
python demo.py
```

This walks through the full QRed flow:

1. Generates an Ed25519 keypair for the issuer
2. Creates a sample document
3. Seals the document into QR-ready seal strings
4. Shows the generated seals
5. Verifies the seals end-to-end → VALID

## Use the demo script

The included `demo.sh` sets up a virtual environment and runs the demo in one command:

```bash
bash demo.sh
```

## Start the API server

```bash
make install   # pip install -r requirements.txt
make run       # uvicorn on port 8190
```

Then use the REST API. The local backend listens on `http://localhost:8190`, and generated bootstrap QR codes target the production verifier at `https://qred.org/verify.htm` by default:

```bash
# Generate seals
curl -X POST http://localhost:8190/api/seals \
  -H 'Content-Type: application/json' \
  -d '{
    "content": "This is my document.",
    "issuer": "QRed Authority",
    "private_key": "<base64_private_key>",
    "public_key": "<base64_public_key>"
}'

# Verify seals
curl -X POST http://localhost:8190/api/verify \
  -H 'Content-Type: application/json' \
  -d '{"seals": ["QRED1|DOC-ABC|0|3|...", "QRED1|DOC-ABC|1|3|..."]}'
```

## Run tests

```bash
make tests     # 91 passing BDD tests
```


# Production deployment for qred.org

The production verifier is expected to be served by Cloudflare Pages at `https://qred.org/verify.htm`. The repository root now includes Cloudflare Pages config and npm build scripts so Cloudflare can publish the frontend even when the project is connected from the repository root. Do not use GoDaddy URL forwarding as the primary production mechanism: forwarding can change the browser-visible URL, introduce redirect dependencies, and does not prove that `/verify.htm` is being served directly by the Cloudflare Pages deployment with Cloudflare-managed TLS.

## Cloudflare Pages build settings

Configure the Cloudflare Pages project with these settings:

| Setting | Value |
| --- | --- |
| Project root / root directory | `frontend` |
| Build command | `npm ci && npm run build` |
| Build output directory | `build` |
| Deploy command, if the Cloudflare UI requires one | `npm ci && npm run build` |
| Production URL expectation | `https://qred.org/verify.htm` |

Use `npm ci && npm run build` only after setting the project root to `frontend`, where `package.json` and `package-lock.json` live. If Cloudflare runs from the repository root, use the root `npm run build` script and publish `frontend/build`; the root `wrangler.jsonc` declares that Pages output directory. If the UI requires manual settings instead, use `cd frontend && npm ci && npm run build` and set the build output directory to `frontend/build`.

The production frontend is a Cloudflare Pages deployment with a small Worker in `frontend/worker/index.js`. By default, the browser build sends API requests to the relative `/api` path, which lets the Worker proxy requests. Configure the Worker variable `QRED_API_ORIGIN` to the origin of the separately deployed QRed FastAPI backend if production should support API-backed demo features such as seal generation, PDF stamping, registry calls, or server-side verification. Alternatively, set the frontend build-time variable `VITE_API_BASE_URL` to the backend origin (for example, `https://api.qred.org`) so the browser calls that API directly instead of relying on the Worker proxy. Leave both `QRED_API_ORIGIN` and `VITE_API_BASE_URL` unset only for a static verifier/demo deployment; in that mode the Worker serves `/api/keys/default` and `/api/keys/demo` locally so the homepage can load demo issuer keys, while other `/api/*` routes return a 503 explaining that the backend origin is missing.

Optional Worker variables for stable homepage demo keys are:

| Variable | Purpose |
| --- | --- |
| `QRED_DEFAULT_PRIVATE_KEY` | Base64URL-encoded Ed25519 private key used by the browser demo. |
| `QRED_DEFAULT_PUBLIC_KEY` | Matching Base64URL-encoded Ed25519 public key. |
| `QRED_DEFAULT_KEY_ID` | Optional key ID. If omitted, the Worker derives it from `QRED_DEFAULT_PUBLIC_KEY`. |

When using direct browser API calls, add `VITE_API_BASE_URL=https://api.qred.org` (or another production API origin) as a Cloudflare Pages build-time variable and rebuild the frontend. `VITE_API_PROXY_TARGET` is only used by the local Vite development proxy and is not a production Pages setting.

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
- Generated bootstrap URLs in sealed PDFs and API responses point to `https://qred.org/verify.htm`.

A quick HTTP check for the required verifier route is:

```bash
curl -I https://qred.org/verify.htm
```

The response should resolve directly on `https://qred.org/verify.htm`, present a valid TLS certificate, and return a successful HTTP status from the Cloudflare Pages deployment. If `www.qred.org` is enabled, also verify the intended `www` behavior, for example:

```bash
curl -I https://www.qred.org/verify.htm
```

## Bootstrap URL stability

QRed-generated bootstrap QR codes target `https://qred.org/verify.htm` by default. The path `/verify.htm` is part of the printed QR bootstrap contract: changing or removing it can break already-issued printed documents. Keep `/verify.htm` stable, and if the verifier application is reorganized, preserve this path with a direct Cloudflare Pages route or rewrite that continues to serve the verifier.

# Motivation

Many documents are distributed in printed form and may be photocopied, scanned, emailed, faxed, or manually altered. While digital signatures are well understood in electronic documents, there is no widely adopted method for making printed documents self-verifying.

QRed bridges the gap between physical and digital documents by embedding a signed representation of the document directly on the page.

This allows recipients to verify:

- The document was issued by the certifying authority.
- The certified contents have not been altered.
- The displayed contents match the original signed document.

# How It Works

1. A document is converted into a canonical text representation.
2. The canonical text is digitally signed by the issuing authority.
3. The signed payload is compressed and divided into one or more QR code seals.
4. A bootstrap QR code containing a URL to a verifier web application is added to the document.
5. The QR seals are printed alongside the document.
6. A recipient scans the bootstrap QR code.
7. The verifier web application scans the remaining QR seals.
8. The payload is reconstructed and the signature is verified.
9. The certified contents are displayed to the user.

# Design Goals

- No dedicated mobile application required.
- Works with standard smartphone cameras.
- Offline verification after payload acquisition.
- Open and interoperable format.
- Resistant to casual document tampering.
- Supports multi-page and high-content documents.
- Binds backend-sealed PDF pages with signed page hashes and a shared document Merkle root, using the root in QR grouping data so swapped-in pages can be detected.
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

The payload QR codes contain the signed document data required to reconstruct and validate the certified contents.

# Security Model

QRed relies on public key cryptography.

Each issuing authority maintains a signing key pair:

- Private key: used to sign document payloads.
- Public key: used by the verifier to validate signatures.

Any modification to the sealed document contents invalidates the signature and causes verification to fail.

# Status

QRed is currently an experimental specification and reference implementation.

The format, payload structure, chunking rules, compression algorithms, and verification workflow may evolve as the project matures.

# License

This project is released under the Apache License 2.0.
