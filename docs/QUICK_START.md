# QRed development quick start

QRed seals PDFs and verifies their contents in the browser. Google account
attestations use the Cloudflare Worker in `frontend/worker/`. The private-key
workflow can run from the static frontend alone.

## Run the frontend

Use Node.js 24, matching CI:

```bash
cd frontend
npm ci
npm start
```

Open the Vite URL, choose **Stamp PDF**, generate or open a signing key, and
choose a PDF. **Stamp and save PDF** downloads the sealed document. Both the
homepage and `/verify.htm` can read seals from PDFs, QR images, or the camera.
Private-key seals need the issuer's public key file to verify the signature.

## Run tests

Install Python 3.12 and Poppler (`pdftoppm` and `pdftotext`) for the rendered-PDF
regressions. From the repository root:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium
npm run lint --prefix frontend
npm test --prefix frontend
npm run build --prefix frontend
```

Serve the production build in one terminal:

```bash
cd frontend
npm exec vite preview -- --host 127.0.0.1 --port 3000
```

In another terminal, activate the Python environment and run from the repository
root:

```bash
QRED_BASE_URL=http://localhost:3000 pytest -v
```

The browser tests exercise the production service worker and offline caches.
They share download, cache-readiness, and network-observation helpers in
`tests/browser_helpers.py`.

## Code map

| Location | Responsibility |
| --- | --- |
| `frontend/src/pdfClientSeal.js` | Prepare and sign each page |
| `frontend/src/pdf/renderSealedPdf.js` | Place seals and check watermark recovery |
| `frontend/src/sealBudget.js` | QR capacity and optional-evidence budgets |
| `frontend/src/sealCompression.js` | Shared compression selection |
| `frontend/src/verifier/verificationSession.js` | Collected seals, verification lifetime, and progress |
| `frontend/src/qr/cameraSession.js` | Camera stream and decode-loop lifetime |
| `frontend/worker/` | Stateless Google identity attestations |
| `tests/` | Production browser regression tests |

See the [README](../README.md) for the seal format, privacy model, and Cloudflare
Pages deployment instructions.
