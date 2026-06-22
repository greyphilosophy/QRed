# QRed — Tamper-Evident Document Sealing & Verification

## Quick Start

### Backend
```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.app:create_app --factory --reload --port 8000
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
npm run dev -- --host 127.0.0.1
```

Open the Vite URL shown in the terminal, use **Use Demo Keys**, choose a PDF, and click **Upload PDF and Stamp QR Seals**. The downloaded PDF contains `https://qred.org/verify.htm` bootstrap QR codes and QRed payload seal QR codes for the verifier workflow.
