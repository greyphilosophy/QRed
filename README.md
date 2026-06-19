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

Then use the REST API:

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
make tests     # 82 passing BDD tests
```

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
