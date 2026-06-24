# QRed — Tamper-Evident Document Sealing & Verification

## Quick Start

### Backend
The local API runs on port `8190`.

```bash
# From the repository root
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.app:create_app --factory --reload --port 8190
```

### Frontend
```bash
cd frontend
npm install
npm start
```

### Running BDD Tests
```bash
PYTHONPATH=. pytest tests/ -v
```

## Project Structure
```
QRed/
├── backend/
│   ├── app.py          # FastAPI app factory
│   ├── models.py       # QRed data models
│   ├── routes/
│   │   ├── seal.py     # Seal generation API
│   │   └── verify.py   # Verification API
│   └── services/
│       ├── sealer.py   # Document sealing logic
│       └── verifier.py # Verification logic
├── frontend/
│   ├── index.html      # SPA entry point
│   ├── package.json
│   ├── vite.config.js
│   └── src/
│       ├── index.js    # React entry
│       └── App.jsx     # React SPA
├── tests/
│   └── test_qred.py    # BDD test suite
└── .github/workflows/ci.yml
```

## API Endpoints

Use `http://localhost:8190` for local API requests. Generated bootstrap QR codes target the production verifier at `https://qred.org/verify.htm` by default.

### POST /api/seals
Generate QRed seals for a document.

### POST /api/verify
Verify QRed seals and return verification result.

## Windows 11 Anaconda Demo

From **Anaconda Prompt** or **PowerShell** at the repository root:

```powershell
conda create -n qred-demo python=3.12 -y
conda activate qred-demo
python -m pip install -r requirements.txt
uvicorn backend.app:create_app --factory --reload --port 8190
```

In a second terminal:

```powershell
cd frontend
npm install
npm start -- --host 127.0.0.1
```

The Vite dev server proxies `/api` to `http://localhost:8190` by default. Open the Vite URL shown in the terminal, use **Use Demo Keys**, choose a PDF, and click **Upload PDF and Stamp QR Seals**. The downloaded PDF contains QRed payload QR codes for the verifier workflow. Backend PDF sealing signs each page with integrity metadata that includes a page content hash and a shared document Merkle root, and uses that root in the public QR `doc` grouping value instead of a generated document ID. Scanned page seals from the same PDF can be compared for swap detection.
