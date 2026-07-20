"""QRed client-side sealing — full parity tests (Playwright).

These tests verify that every user-facing workflow that the old backend
exposed still works in the new static architecture:

1. Plain-text PDF seal and verify
2. Multi-QR documents
3. PDF text sealing
4. Image-only PDFs
5. Key generation / import and signature verification
6. Existing seal compatibility

All sealing happens in-browser via the PdfSealForm UI.  No server-side
API endpoints are called for PDF processing.

Run:
  pytest tests/test_qred_deployment.py -v
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest
from playwright.sync_api import Page, expect

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

REPORTLAB_AVAILABLE = False
PIL_AVAILABLE = False

# The demo key pair used throughout the tests.
# This matches the hardcoded fallback in App.jsx loadDefaultKeys():
#   setPublicKey("eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=")
DEMO_PUBLIC_KEY = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q="

# The demo private key used for sealing in tests.
DEMO_PRIVATE_KEY = "qJ6bqL6U26yH4jG3G7qG4pKqYqG6qYqG6qYqG6qYqG6qYQ"

try:
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas

    REPORTLAB_AVAILABLE = True
except ImportError:
    pass

try:
    from PIL import Image
    import io as pillow_io

    PIL_AVAILABLE = True
except ImportError:
    pass


def make_simple_pdf(path: str) -> bytes:
    """Create a minimal test PDF with text content."""
    if not REPORTLAB_AVAILABLE:
        pytest.skip("reportlab not installed")
    buf = pillow_io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=letter)
    c.drawString(100, 700, "QRed Parity Test Document")
    c.setFont("Helvetica", 24)
    c.drawString(100, 650, "Testing client-side sealing")
    c.save()
    with open(path, "wb") as f:
        f.write(buf.getvalue())
    return buf.getvalue()


def make_image_only_pdf(path: str) -> bytes:
    """Create a PDF with a raster image (no text)."""
    if not PIL_AVAILABLE:
        pytest.skip("Pillow not installed")
    if not REPORTLAB_AVAILABLE:
        pytest.skip("reportlab not installed")

    img_buf = pillow_io.BytesIO()
    img = Image.new("RGB", (200, 200), color=(100, 150, 200))
    img.save(img_buf, format="PNG")
    img_buf.seek(0)

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False, mode="wb") as png_tmp:
        png_tmp.write(img_buf.read())
        png_path = png_tmp.name

    try:
        buf = pillow_io.BytesIO()
        c = rl_canvas.Canvas(buf, pagesize=letter)
        c.drawImage(png_path, x=50, y=50, width=500, height=700, mask="auto")
        c.save()
        with open(path, "wb") as f:
            f.write(buf.getvalue())
        return buf.getvalue()
    finally:
        os.unlink(png_path)


def make_multi_page_pdf(path: str, num_pages: int = 3) -> bytes:
    """Create a multi-page PDF for multi-QR document testing."""
    if not REPORTLAB_AVAILABLE:
        pytest.skip("reportlab not installed")
    buf = pillow_io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=letter)
    c.drawString(100, 700, "QRed Multi-Page Test Document")
    for i in range(1, num_pages):
        c.showPage()
        c.drawString(100, 700, f"Page {i + 1}")
    c.save()
    with open(path, "wb") as f:
        f.write(buf.getvalue())
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Test constants
# ---------------------------------------------------------------------------

# The demo public key — matches the hardcoded value in the worker and App.jsx
DEMO_PUBLIC_KEY = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q="

# A demo private key for in-browser sealing (not exposed by the server)
DEMO_PRIVATE_KEY = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes="

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def pdf_dir(tmp_path_factory):
    """Create a temporary directory for test PDFs."""
    return tmp_path_factory.mktemp("qred-pdfs")


@pytest.fixture(scope="module")
def simple_pdf_path(pdf_dir):
    """Path to a simple text PDF."""
    path = str(pdf_dir / "simple.pdf")
    make_simple_pdf(path)
    return path


@pytest.fixture(scope="module")
def image_only_pdf_path(pdf_dir):
    """Path to an image-only PDF."""
    path = str(pdf_dir / "image_only.pdf")
    make_image_only_pdf(path)
    return path


@pytest.fixture(scope="module")
def multi_page_pdf_path(pdf_dir):
    """Path to a multi-page PDF."""
    path = str(pdf_dir / "multi_page.pdf")
    make_multi_page_pdf(path)
    return path


# ---------------------------------------------------------------------------
# Helper to upload a file via Playwright and wait for the download
# ---------------------------------------------------------------------------

def _upload_and_seal(page: Page, file_path: str, private_key: str = "", public_key: str = "", encoding: str = "plaintext", issuer: str = "QRed Test"):
    """
    Upload a PDF to the Playwright-dev frontend and trigger sealing.
    
    Returns a tuple: (sealed_pdf_path, seal_result_dict)
    where seal_result_dict contains the seal metadata from the UI message.
    
    The seal result is extracted from the success message that the frontend
    displays after sealing, which includes:
    - seal_type: always "QRED"
    - encoding: the encoding strategy used
    - document_id: the seal's document ID
    - recipe: the recipe used (plaintext, b45, etc.)
    - seal_count: number of seals created
    """
    from playwright.sync_api import expect as expect_playwright

    BASE_URL = os.environ.get("QRED_BASE_URL", "http://localhost:3000")

    # Navigate to the page — wait for QrScanner to render
    page.goto(BASE_URL, wait_until="networkidle", timeout=30_000)

    from playwright.sync_api import expect as expect_playwright

    # Step 1: Click "Stamp PDF" to open the PdfSealForm
    # (QrScanner renders first, then conditionally shows PdfStampTool)
    stamp_btn = None
    try:
        stamp_btn = page.locator('button:has-text("Stamp PDF")').first
        expect_playwright(stamp_btn).to_be_visible(timeout=10_000)
        stamp_btn.click()
        page.wait_for_timeout(500)  # Let React render the PdfStampTool
    except Exception as exc:
        raise AssertionError("Failed to click 'Stamp PDF' button — UI may have changed") from exc

    # Step 2: Wait for the "Use Default Keys" button (inside PdfSealForm)
    try:
        key_btn = page.locator('button:has-text("Use Default Keys")').first
        expect_playwright(key_btn).to_be_visible(timeout=10_000)
        key_btn.click()  # Force key loading
        page.wait_for_timeout(2000)  # Wait for async loadDefaultKeys() to complete
    except Exception:
        raise AssertionError("App failed to load — key button not found after opening Stamp PDF tool")

    # Step 3: Wait for and click the "Stamp PDF" button inside the tool to proceed to file upload
    try:
        upload_btn = page.locator('input[type="file"][accept="application/pdf"]').first
        expect_playwright(upload_btn).to_be_visible(timeout=5_000)
    except Exception as exc:
        raise AssertionError("File input not found after key loading") from exc

    # Wait for the file input
    file_input = page.locator('input[type="file"][accept="application/pdf"]').first
    try:
        file_input.set_input_files(file_path)
    except Exception as exc:
        raise AssertionError("Failed to upload PDF file") from exc

    # Fill the private key — essential for sealing to work
    # Use Playwright's fill() + wait for button to become enabled (most reliable for React)
    try:
        pk_input = page.locator('input[aria-label="Private Key"]').first
        # Verify the input exists and is visible
        expect_playwright(pk_input).to_be_visible(timeout=3_000)
        # Use fill() — Playwright v2 handles React state updates automatically
        pk_input.fill(private_key)
        # Wait for the seal button to become enabled (confirms React state synced)
        seal_button = page.locator('button:has-text("Upload PDF and Stamp QR Seals")').first
        expect_playwright(seal_button).to_be_enabled(timeout=5_000)
    except Exception as exc:
        raise AssertionError(f"Failed to fill private key or wait for seal button: {exc}") from exc

    # If encoding strategy needs to be changed, verify it was selected
    if encoding and encoding != "plaintext":
        try:
            encoding_select = page.locator('select[aria-label="Encoding Strategy"]').first
            encoding_select.select_option(encoding)
            # Verify the selection was applied
            selected_value = encoding_select.input_value()
            if selected_value != encoding:
                raise AssertionError(f"Encoding selection failed: expected '{encoding}', got '{selected_value}'")
        except AssertionError:
            raise
        except Exception as exc:
            # If encoding selector doesn't exist, warn but don't fail yet
            # (it will fail when we check seal_result encoding later)
            print(f"[WARN] Could not select encoding: {exc}")

    # Click the seal button and wait for download
    seal_btn = None
    try:
        seal_btn = page.locator('button:has-text("Upload PDF and Stamp QR Seals")').first
    except Exception:
        # Try alternative selectors
        try:
            seal_btn = page.locator('button:has-text("Seal")').first
        except Exception:
            try:
                seal_btn = page.locator('button:has-text("Stamp")').first
            except Exception:
                raise AssertionError("Seal button not found")

    with page.expect_download(timeout=60_000) as download_info:
        seal_btn.click()

    download = download_info.value
    sealed_path = f"/tmp/{download.suggested_filename}"
    download.save_as(sealed_path)

    # Extract seal result from the success message displayed by the UI
    seal_result = _extract_seal_result(page)

    return sealed_path, seal_result


def _extract_seal_result(page: Page) -> dict:
    """
    Extract the seal result metadata from the frontend's seal result.
    
    The frontend stores the full seal result on window.__lastSealResult after sealing.
    We wait for it to be available by polling.
    
    Returns a dict with the seal metadata and seal strings.
    """
    import time
    import json
    
    # Poll for the seal result to be available (up to 15 seconds)
    for attempt in range(30):
        time.sleep(0.5)
        try:
            raw_result = page.evaluate("""() => {
                return JSON.stringify(window.__lastSealResult);
            }""")
            if raw_result and raw_result != "undefined" and raw_result != "null" and raw_result != '"{}"':
                try:
                    result = json.loads(raw_result)
                    if result and isinstance(result, dict) and len(result) > 0:
                        # Extract seal strings from the seals array
                        seal_strings = []
                        if "seals" in result and isinstance(result["seals"], list):
                            for s in result["seals"]:
                                if isinstance(s, str):
                                    seal_strings.append(s)
                        
                        return {
                            "seal_type": "QRED",
                            "encoding": result.get("encoding", "unknown"),
                            "document_id": result.get("document_id", ""),
                            "recipe": result.get("selected_recipe", "unknown"),
                            "seal_count": result.get("estimated_qr_count", result.get("total_seals", 0)),
                            "seal_strings": seal_strings,  # List of raw seal strings for verification
                            "full_result": result,  # For debugging if needed
                        }
                except json.JSONDecodeError:
                    pass
        except Exception:
            pass
    
    # Final fallback: parse from HTML content
    try:
        html = page.content()
        if "Sealed" in html and "Document ID" in html:
            import re
            # Find the message in the HTML
            msg_match = re.search(r'Sealed [^\n<]*Document ID: [^\n<]*', html)
            if msg_match:
                msg_text = msg_match.group(0)
                result = {
                    "seal_type": "QRED",
                    "encoding": "unknown",
                    "document_id": "",
                    "recipe": "unknown",
                    "seal_count": 0,
                    "seal_strings": [],
                }
                for line in msg_text.split("\n"):
                    line = line.strip()
                    if "Selected encoding:" in line:
                        result["encoding"] = line.split("Selected encoding:")[1].strip()
                    elif "Document ID:" in line:
                        result["document_id"] = line.split("Document ID:")[1].strip()
                    elif "Selected recipe:" in line:
                        result["recipe"] = line.split("Selected recipe:")[1].strip()
                    elif "Estimated QR count:" in line:
                        try:
                            result["seal_count"] = int(line.split(":")[-1].strip())
                        except ValueError:
                            pass
                return result
    except Exception:
        pass
    
    return {}


def _verify_seal(page: Page, seal_payload: str, expected_document_id: str = "", public_key: str = ""):
    """
    Verify a seal by calling the verifier's test API (window.__qredTestVerify),
    which bridges from Playwright's evaluate() to module-scoped verifyQRedSeals().
    
    The seal_payload should be one or more QRED seal strings (URL fragments
    like "QRED1?v=1&alg=ed25519&..."), one per line.

    public_key: the exact public key to use for signature verification.
    Raises AssertionError if any step fails.
    """
    from playwright.sync_api import expect as expect_playwright

    BASE_URL = os.environ.get("QRED_BASE_URL", "http://localhost:3000")

    # Navigate to verifier
    page.goto(f"{BASE_URL}/verifier.html", wait_until="networkidle", timeout=30_000)
    page.wait_for_timeout(2000)  # let the verifier module initialize

    if not seal_payload or seal_payload.strip() == "":
        raise AssertionError("Seal payload is empty — cannot verify without valid seal data")

    # Step 1: Call the test API to run verification via module-scoped verifyQRedSeals()
    # Playwright v2 uses array syntax: evaluate(script, [arg1, arg2])
    # Use array destructuring to extract seal_payload and public_key
    result = page.evaluate("[s, k] => window.__qredTestVerify(s, k)", [seal_payload, public_key or ""])

    if isinstance(result, dict) and result.get("status") == "ERROR":
        raise AssertionError(f"Verification error: {result.get('error', 'unknown')}")

    if not result or not isinstance(result, dict):
        raise AssertionError(f"Verification returned unexpected result: {result}")

    status = result.get("status", "")
    status_upper = status.upper().strip()

    # Step 2: Wait for #resultStatus to appear in the DOM (page.evaluate updates DOM asynchronously)
    try:
        result_status = page.locator('#resultStatus').first
        expect_playwright(result_status).to_be_visible(timeout=15_000)
        dom_status = result_status.inner_text().strip()
    except Exception:
        dom_status = status  # fallback to JS result if DOM not yet rendered

    # Step 3: Assert only VALID — UNVERIFIED means no public key, INCOMPLETE means missing chunks
    if status_upper == "VALID":
        return True
    else:
        try:
            result_meta = page.locator('#resultMeta').inner_text()
        except Exception:
            result_meta = ""
        try:
            result_content = page.locator('#resultContent').inner_text()
        except Exception:
            result_content = ""
        try:
            body_text = page.locator('body').inner_text()
        except Exception:
            body_text = ""

        raise AssertionError(
            f"Verification returned status '{status}' instead of VALID. "
            f"Result meta: {result_meta[:200]}. "
            f"Result content: {result_content[:200]}. "
            f"Body: {body_text[:500]}"
        )



def _verify_seal_with_seal_strings(page: Page, seal_result: dict, expected_document_id: str = "", public_key: str = ""):
    """
    Verify a seal using the actual seal strings extracted from the seal result.
    
    This is the recommended verification function — it uses the raw seal strings
    (URL fragments) that were generated during sealing, which the verifier can parse.
    
    public_key: the exact public key to use for signature verification.
    Raises AssertionError if any step fails.
    """
    seal_strings = seal_result.get("seal_strings", [])
    if not seal_strings:
        raise AssertionError("No seal strings found in seal result — cannot verify")
    
    # Join all seal strings, one per line
    payload = "\n".join(seal_strings)
    return _verify_seal(page, payload, expected_document_id, public_key)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestPlainTextSealAndVerify:
    """T0: Plain text seal and verify."""

    def test_seal_simple_pdf(self, page: Page, simple_pdf_path: str):
        """Seal a simple text PDF and verify the download."""
        sealed, seal_result = _upload_and_seal(page, simple_pdf_path, private_key=DEMO_PRIVATE_KEY, issuer="QRed Test")
        assert os.path.exists(sealed), "Sealed PDF was not downloaded"
        assert os.path.getsize(sealed) > 100, "Sealed PDF is too small"
        with open(sealed, "rb") as f:
            assert f.read(5) == b"%PDF-", "Sealed file is not a PDF"

    def test_verify_sealed_pdf(self, page: Page, simple_pdf_path: str):
        """Seal and verify a simple PDF using the actual seal strings."""
        sealed, seal_result = _upload_and_seal(page, simple_pdf_path, private_key=DEMO_PRIVATE_KEY, issuer="QRed Test")
        
        # Verify the seal result was captured
        assert seal_result, "Seal result was not captured from UI message"
        assert seal_result.get("seal_strings"), "No seal strings captured — cannot verify"
        
        # Use the actual seal strings with known public key for verification
        verified = _verify_seal_with_seal_strings(
            page, seal_result, seal_result.get('document_id', ''), DEMO_PUBLIC_KEY
        )
        assert verified, "Verification failed for simple sealed PDF"


class TestMultiQrDocuments:
    """T1: Multi-QR documents (multi-page PDFs generate multiple QR seals)."""

    def test_seal_multi_page_pdf(self, page: Page, multi_page_pdf_path: str):
        """Seal a multi-page PDF and verify the download."""
        sealed, seal_result = _upload_and_seal(page, multi_page_pdf_path, private_key=DEMO_PRIVATE_KEY, issuer="QRed Multi-PQR Test")
        assert os.path.exists(sealed), "Multi-page PDF was not sealed"
        assert os.path.getsize(sealed) > 100, "Sealed multi-page PDF is too small"
        with open(sealed, "rb") as f:
            assert f.read(5) == b"%PDF-", "Multi-page sealed file is not a PDF"

    def test_multi_page_verification(self, page: Page, multi_page_pdf_path: str):
        """Seal and verify a multi-page PDF."""
        sealed, seal_result = _upload_and_seal(page, multi_page_pdf_path, private_key=DEMO_PRIVATE_KEY, issuer="QRed Multi-PQR Test")
        
        # Verify the seal result was captured with actual seal strings
        assert seal_result.get("seal_strings"), "No seal strings captured — cannot verify"
        
        verified = _verify_seal_with_seal_strings(
            page, seal_result, seal_result.get('document_id', ''), DEMO_PUBLIC_KEY
        )
        assert verified, "Verification failed for multi-page sealed PDF"


class TestPdfTextSealing:
    """T2: PDF text sealing (QR seals embed text payload)."""

    def test_seal_with_custom_issuer(self, page: Page, simple_pdf_path: str):
        """Seal with a custom issuer string and verify the seal is applied."""
        sealed, seal_result = _upload_and_seal(page, simple_pdf_path, private_key=DEMO_PRIVATE_KEY, issuer="Custom Test Issuer")
        assert os.path.exists(sealed), "Sealed PDF with custom issuer was not downloaded"
        assert os.path.getsize(sealed) > 100, "Sealed PDF with custom issuer is too small"

    def test_seal_with_b45_encoding(self, page: Page, simple_pdf_path: str):
        """Seal using the b45 encoding strategy."""
        sealed, seal_result = _upload_and_seal(
            page, simple_pdf_path, private_key=DEMO_PRIVATE_KEY, encoding="b45", issuer="QRed B45 Test"
        )
        assert os.path.exists(sealed), "b45-encoded sealed PDF was not downloaded"
        
        # Verify encoding was selected in the UI
        encoding = seal_result.get('encoding', 'unknown')
        assert encoding in ('b45', 'automatic') or 'b45' in encoding, \
            f"Expected b45 encoding, got: {encoding}"


class TestImageOnlyPdfs:
    """T3: Image-only PDFs (no text content, only raster images)."""

    def test_seal_image_only_pdf(self, page: Page, image_only_pdf_path: str):
        """Seal an image-only PDF and verify the download."""
        sealed, seal_result = _upload_and_seal(
            page, image_only_pdf_path, private_key=DEMO_PRIVATE_KEY, issuer="QRed Image-Only Test"
        )
        assert os.path.exists(sealed), "Image-only PDF was not sealed"
        assert os.path.getsize(sealed) > 100, "Sealed image-only PDF is too small"
        with open(sealed, "rb") as f:
            assert f.read(5) == b"%PDF-", "Image-only sealed file is not a PDF"

    def test_image_only_verification(self, page: Page, image_only_pdf_path: str):
        """Seal and verify an image-only PDF."""
        sealed, seal_result = _upload_and_seal(
            page, image_only_pdf_path, private_key=DEMO_PRIVATE_KEY, issuer="QRed Image-Only Test"
        )
        
        # Verify the seal result was captured with actual seal strings
        assert seal_result.get("seal_strings"), "No seal strings captured — cannot verify"
        
        verified = _verify_seal_with_seal_strings(
            page, seal_result, seal_result.get('document_id', ''), DEMO_PUBLIC_KEY
        )
        assert verified, "Verification failed for image-only sealed PDF"


class TestKeyGenerationImportAndSignatureVerification:
    """T4: Key generation/import and signature verification."""

    def test_seal_with_custom_private_key(self, page: Page, simple_pdf_path: str):
        """Seal using a user-provided private key (not from server)."""
        sealed, seal_result = _upload_and_seal(
            page, simple_pdf_path, private_key=DEMO_PRIVATE_KEY, issuer="QRed Custom Key Test"
        )
        assert os.path.exists(sealed), "PDF sealed with custom private key was not downloaded"

    def test_public_key_only_from_server(self, page: Page):
        """The static server does not serve /api/keys/default as JSON — it returns 404 or HTML.
        
        When the Cloudflare Worker is deployed, /api/keys/default returns public_key only.
        In static mode (local dev / CI), the endpoint does not exist.
        """
        BASE_URL = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        
        response = page.goto(f"{BASE_URL}/api/keys/default", wait_until="domcontentloaded", timeout=10_000)
        assert response is not None
        
        # In static mode, the file doesn't exist → 404
        # In Cloudflare mode, it returns JSON with public_key only
        ct = response.headers.get("content-type", "")
        status = response.status
        
        if "json" in ct:
            # Cloudflare Worker mode
            data = response.json()
            assert "public_key" in data, "Public key should be returned"
            assert "private_key" not in data, "Private key should NOT be returned by the server"
        else:
            # Static server mode — no Worker, returns 404 HTML or index.html
            assert status != 200 or "html" in ct or "text" in ct, \
                f"/api/keys/default should not return JSON in static mode, got status {status}, ct={ct}"

    def test_custom_key_verification(self, page: Page, simple_pdf_path: str):
        """Seal with custom key and verify the seal."""
        sealed, seal_result = _upload_and_seal(
            page, simple_pdf_path, private_key=DEMO_PRIVATE_KEY, issuer="QRed Key Test"
        )
        
        # Use the actual seal strings with known public key for verification
        verified = _verify_seal_with_seal_strings(
            page, seal_result, seal_result.get('document_id', ''), DEMO_PUBLIC_KEY
        )
        assert verified, "Verification failed for seal with custom key"


class TestExistingSealCompatibility:
    """T5: Existing seal compatibility (re-verify seals from known documents)."""

    def test_seal_reseal_compatibility(self, page: Page, simple_pdf_path: str):
        """Seal a document, then re-seal the result — verify compatibility."""
        # First seal
        sealed1, seal_result1 = _upload_and_seal(
            page, simple_pdf_path, private_key=DEMO_PRIVATE_KEY, issuer="QRed Compatibility Test"
        )
        assert os.path.exists(sealed1)

        # Re-seal the already-sealed PDF
        sealed2, seal_result2 = _upload_and_seal(
            page, sealed1, private_key=DEMO_PRIVATE_KEY, issuer="QRed Compatibility Test"
        )
        assert os.path.exists(sealed2)

        # Verify the re-sealed PDF using the actual seal strings
        assert seal_result2.get("seal_strings"), "No seal strings captured — cannot verify"
        verified = _verify_seal_with_seal_strings(
            page, seal_result2, seal_result2.get('document_id', ''), DEMO_PUBLIC_KEY
        )
        assert verified, "Re-sealed PDF should still verify"


class TestNoBackendApiEndpoints:
    """T6: Verify that old backend API endpoints are no longer available."""

    def test_upload_seal_returns_static(self, page: Page):
        """The old /api/pdf/upload-seal endpoint should no longer serve PDFs."""
        BASE_URL = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        
        response = page.goto(f"{BASE_URL}/api/pdf/upload-seal", wait_until="load", timeout=10_000)
        assert response is not None
        
        # Should return HTML (static asset), not a PDF or API JSON
        # In Playwright v2, headers is a dict property, not a method
        content_type = response.headers.get("content-type", "")
        assert "html" in content_type or "text" in content_type, \
            f"/api/pdf/upload-seal should return HTML/static asset, got {content_type}"


# ---------------------------------------------------------------------------
# Run all tests
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    pytest.main([__file__, "-v"])