# QRed Demo BDD Scenarios

These scenarios describe the Windows 11 demo flow for QRed using a local FastAPI backend and the browser UI opened from `frontend/index.html`.

## Feature: Launch the local demo application

### Scenario: Open the browser application
**Given** the QRed backend is running locally  
**And** the frontend has been started with Vite  
**When** the demonstrator opens `index.html` in a browser  
**Then** the page shows controls for uploading a PDF, generating text seals, and verifying seals.

## Feature: Seal an uploaded PDF

### Scenario: Stamp every PDF page with QRed seals
**Given** the demonstrator has selected a PDF file  
**And** an issuer name, Ed25519 private key, and Ed25519 public key are available  
**When** the demonstrator clicks **Upload PDF and Stamp QR Seals**  
**Then** the backend extracts canonical text from the PDF  
**And** signs the canonical text  
**And** chunks the signed payload into one or more QRed payload seals  
**And** stamps each PDF page with a bootstrap QR code for `https://qred.org/verify.htm`  
**And** stamps each PDF page with one or more payload QR codes when space allows  
**And** returns a sealed PDF download.

## Feature: Smartphone bootstrap verification

### Scenario: Launch verifier from a stamped document
**Given** a sealed PDF page includes a bootstrap QR code  
**When** the recipient scans that QR code with a smartphone camera  
**Then** the smartphone opens `https://qred.org/verify.htm`  
**And** the verifier page offers a camera scanner, manual seal entry, text-file upload, and issuer public-key entry.

## Feature: Reconstruct and verify a sealed document

### Scenario: Verify QRed payload seals
**Given** the verifier has collected all payload QR seal strings for one document  
**And** the issuer public key is available from a trusted registry or demo input  
**When** the recipient clicks **Verify Document**  
**Then** the verifier reconstructs the compressed signed payload  
**And** submits the collected payload seals and issuer public key to the verification API  
**And** verifies the Ed25519 signature over the original canonical document text  
**And** displays the verification status, original document text, document ID, timestamp, and signature issuer.

### Scenario: Detect missing payload seals
**Given** the verifier has collected only some payload QR seal strings for a document  
**When** the recipient attempts verification  
**Then** the result is `INCOMPLETE`  
**And** the verifier reports which chunk numbers are missing.

### Scenario: Detect tampered signed content
**Given** a signed QRed payload seal has been altered  
**When** the recipient attempts verification with the issuer public key  
**Then** the result is not `VALID`  
**And** the verifier does not present the altered document as authentic.
