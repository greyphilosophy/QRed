# QRed Plaintext-First Implementation Plan

> **For Hermes:** Use `subagent-driven-development` to implement this plan task-by-task.

**Goal:** Make plaintext the default QRed format, keep the scanner universal, and reserve hidden-payload formats/compact formats for cases where plaintext is too large or multipart.

**Architecture:**
- The frontend should stay SPA-based, but the app shape should be scanner-first: scan any QR payload, display its contents, then offer verification as the next step.
- Parsing logic must remain shared between the scanner, fragment display, and verifier so the QR payload model has a single source of truth.
- The backend should emit plaintext sealed payloads by default, with a compact hidden-payload format only when the data no longer fits as readable text.

**Tech Stack:** React/Vite frontend, Python backend services, jsQR for scanning, existing QRed verifier/signing pipeline, pytest for regression tests.

---

## Task 1: Define the plaintext-first payload model

**Objective:** Document and codify the new QR payload hierarchy so sealed documents default to readable text.

**Files:**
- Modify: `README.md`
- Modify: `SPECIFICATION.md`
- Modify: `REQUIREMENTS.md`
- Modify: `frontend/src/qredFragment.js`

**Step 1: Write the policy in docs**

Add a short section stating:
- plaintext is the default QR payload format
- scanners must display arbitrary QR contents
- scanner-safe hidden payloads is reserved for compact/compressed/multipart cases
- verification is an upgrade path after reading contents

**Step 2: Make the parser explicit about payload types**

Ensure `qredFragment.js` returns a structured shape that can distinguish:
- plain text payloads
- hidden seal payloads
- future compact payloads

**Step 3: Verify the parser still handles raw fragments safely**

Run: `cd frontend && npm run build`
Expected: PASS

---

## Task 2: Make the app scanner-first

**Objective:** Reorder the home experience so scanning is the first action and verification is secondary.

**Files:**
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/FragmentDisplay.jsx`
- Modify: `frontend/src/QrScanner.jsx`

**Step 1: Split the page into an explicit flow**

Update the home page copy and layout so the main sequence is:
1. Scan any QR code
2. Read the payload
3. Verify if it is a QRed seal
4. Use the PDF stamper last

**Step 2: Keep scanner behavior universal**

The scanner should:
- accept any QR payload
- show raw contents for plain text/URLs/Wi-Fi/vCard/etc.
- show QRed-specific metadata only when a QRed payload is detected

**Step 3: Update fragment display copy**

The fragment display should describe itself as a payload reader/preview, not as a verification endpoint unless the payload is actually a QRed seal.

**Step 4: Verify the UI still builds**

Run: `cd frontend && npm run build`
Expected: PASS

---

## Task 3: Make plaintext the default sealed-document output

**Objective:** Change the sealing pipeline so readable text is emitted first, with compact formats only when necessary.

**Files:**
- Modify: `backend/services/sealer.py`
- Modify: `backend/services/pdf_stamp.py`
- Modify: `frontend/src/pdfClientSeal.js`
- Modify: `frontend/src/App.jsx`

**Step 1: Define default plaintext serialization**

Implement the default payload shape as readable text blocks, for example:
- `Text: ...`
- `Signature: ...`
- `Merkle Root: ...`

**Step 2: Preserve compact hidden-payload fallback**

Only switch to scanner-safe hidden payloads or later compact formats when:
- the plaintext payload does not fit in one QR
- multipart encoding is required
- metadata density forces compact representation

**Step 3: Align bootstrap URLs and stamping behavior**

Make sure the stamped QR payload points to the SPA route that reads any fragment, not a standalone display page.

**Step 4: Verify the PDF seal path**

Run: `python -m pytest -q tests/test_qred.py`
Expected: PASS

---

## Task 4: Share parser logic across the three entry points

**Objective:** Remove parser drift between scanner, fragment display, and verifier.

**Files:**
- Modify: `frontend/src/qredFragment.js`
- Modify: `frontend/src/FragmentDisplay.jsx`
- Modify: `frontend/src/QrScanner.jsx`
- Modify: `frontend/src/qredVerifier.js`
- Modify: `frontend/src/App.test.jsx`

**Step 1: Centralize decode behavior**

Use the same shared parser for:
- raw hash fragments in the SPA
- scanner scan results
- verifier payload inspection

**Step 2: Add one canonical payload decoder**

Make sure the shared module owns:
- raw fragment parsing
- QRed hidden-payload detection
- plaintext fallback behavior

**Step 3: Update tests for parser drift**

Add tests for:
- raw plaintext payloads
- URLs with encoded characters
- hidden payloads
- malformed fragment strings

**Step 4: Verify the frontend test suite**

Run: `cd frontend && npm test`
Expected: PASS

---

## Task 5: Add parser-heavy regression tests

**Objective:** Lock in the new format philosophy with explicit tests so future changes do not regress the payload model.

**Files:**
- Modify: `tests/test_qred.py`
- Modify: `frontend/src/App.test.jsx`
- Modify: `frontend/src/qredVerifier.test.js` if needed

**Step 1: Add backend tests for default plaintext output**

Cover:
- plain readable payload generation
- compact fallback when payload is too large
- multipart payload handling

**Step 2: Add frontend parser tests**

Cover:
- scanner-safe hidden payloads fragments
- plain text fragments
- URL/hash strings that should not be mistaken for document text
- scanner display for arbitrary QR payloads

**Step 3: Verify full suite**

Run:
- `cd frontend && npm run build`
- `python -m pytest -q`

Expected:
- build passes
- all tests pass

---

## Task 6: Update user-facing copy and review guidance

**Objective:** Make the product philosophy visible in the UI and docs.

**Files:**
- Modify: `README.md`
- Modify: `frontend/src/App.jsx`
- Modify: `docs/QUICK_START.md`

**Step 1: Add the motto**

Use the wording:
- “Readable unless it has to be clever.”

**Step 2: Clarify verification semantics**

State clearly that:
- scanning shows contents first
- verification is an additional trust check
- plaintext remains valid and expected for normal documents

**Step 3: Verify docs build or render cleanly**

If the repo has doc checks, run them; otherwise confirm the edited markdown renders cleanly in the repo viewer.

---

## Suggested implementation order

1. Task 1 — define the model
2. Task 4 — centralize parser logic
3. Task 5 — add parser regression tests
4. Task 2 — reorder the app UI
5. Task 3 — switch sealing defaults
6. Task 6 — polish docs and copy

---

## Acceptance criteria

- Plaintext is the default QR payload for normal sealed documents.
- Universal scanning works for any QR payload, not just QRed seals.
- hidden-payload formats remains supported for compact or multipart cases.
- Parser logic is shared across scanner, fragment display, and verifier.
- Tests cover both plaintext and compact payload parsing.
- The UI reads naturally as: scanner first, verifier second, stamper third.

---

## Verification checklist

- [ ] `cd frontend && npm run build`
- [ ] `python -m pytest -q`
- [ ] Scanner shows arbitrary QR payload text
- [ ] Plaintext QRed payloads are readable without special decoding
- [ ] hidden payloads still parse correctly
- [ ] Verification still works for signed payloads
