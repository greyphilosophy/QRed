# Test Page: QR Photo Analyzer

## Overview
`test.html` is a standalone HTML page that lets users upload a photo containing a QR code, and displays the analysis results including the visible text and hidden QRed payload data in the QR code padding.

## BDD Requirements

### Feature: QR Photo Analyzer

**As a** QRed developer or tester,  
**I want** to upload a photo of a QR code and see all the data contained in the code, including any hidden payload embedded in the padding,  
**So that** I can verify that QRed seals are encoding and decoding correctly.

---

### Scenario 1: Upload a photo with a readable QR code

**Given** I have opened `test.html` in my browser  
**When** I upload a photo file containing a QR code  
**Then** the page displays:
- The decoded visible text from the QR code
- The QR code version and error correction level
- The QR code dimensions (module count and pixel size)
- Any hidden payload data found in the QR code padding
- A visual representation of the QR code grid with data modules highlighted

---

### Scenario 2: Upload a photo with no detectable QR code

**Given** I have opened `test.html` in my browser  
**When** I upload a photo file where no QR code can be detected  
**Then** the page displays:
- A "No QR code detected" message
- The original photo as a thumbnail preview
- Details about the image dimensions and file size

---

### Scenario 3: Upload a photo with a QRed seal

**Given** I have opened `test.html` in my browser  
**When** I upload a photo of a QRed seal (QR code with hidden payload in padding)  
**Then** the page displays:
- The visible text (e.g., `QRED.ORG` or `qred.org`)
- The hidden payload extracted from the padding area
- The byte offset where the hidden data begins
- The raw hex dump of the hidden payload bytes
- Whether the hidden payload contains valid QRed seal data

---

### Scenario 4: Upload multiple photos at once

**Given** I have opened `test.html` in my browser  
**When** I select or drop multiple photo files containing QR codes  
**Then** the page processes each photo and displays results for every detectable QR code, showing one result card per uploaded photo.

---

### Scenario 5: Show unreadable QR code details

**Given** I have opened `test.html` in my browser  
**When** I upload a photo of a QR code that decodes partially (e.g., error correction covers most of it)  
**Then** the page shows:
- The partially decoded text (if any)
- The error correction level and module count
- A message indicating the code was readable but possibly imperfect

---

## Non-Goals

- Camera-based scanning (that's `QrScanner.jsx`)
- Signature verification or seal reconstruction (that's the verifier)
- PDF-specific features (that's `index.html`)
