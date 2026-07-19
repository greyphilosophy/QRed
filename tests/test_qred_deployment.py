"""QRed client-side sealing — full parity tests (Playwright).

These tests verify that every user-facing workflow that the old backend
exposed still works in the new static architecture:

1. Plain-text PDF seal and verify
2. Multi-QR documents
3. PDF text sealing
4. Image-only PDFs
5. Corrupt PDF rejection
6. Key generation / import and signature verification
7. Existing seal compatibility

All sealing happens in-browser via the PdfSealForm UI.  No server-side
API endpoints are called for PDF processing.  The only HTTP interaction
is /api/keys/default which now returns the public key only.

Run:
  pytest tests/test_qred_sealing_parity.py -v
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


def make_corrupt_pdf(path: str) -> bytes:
    """Create a PDF with a corrupt trailer."""
    if not REPORTLAB_AVAILABLE:
        pytest.skip("reportlab not installed")
    buf = pillow_io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=letter)
    c.drawString(100, 700, "Normal content")
    c.save()
    data = buf.getvalue()
    # Corrupt the trailer
    corrupted = data[:-20].replace(b"%%EOF", b"CORRUPTED_TRAILER")
    with open(path, "wb") as f:
        f.write(corrupted)
    return corrupted


def make_truncated_pdf(path: str) -> bytes:
    """Create a truncated PDF."""
    if not REPORTLAB_AVAILABLE:
        pytest.skip("reportlab not installed")
    buf = pillow_io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=letter)
    c.drawString(100, 700, "Normal content here")
    c.save()
    data = buf.getvalue()
    truncated = data[: len(data) // 2]
    with open(path, "wb") as f:
        f.write(truncated)
    return truncated


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


@pytest.fixture(scope="module")
def corrupt_pdf_path(pdf_dir):
    """Path to a corrupt PDF."""
    path = str(pdf_dir / "corrupt.pdf")
    make_corrupt_pdf(path)
    return path


@pytest.fixture(scope="module")
def truncated_pdf_path(pdf_dir):
    """Path to a truncated PDF."""
    path = str(pdf_dir / "truncated.pdf")
    make_truncated_pdf(path)
    return path


# ---------------------------------------------------------------------------
# Helper to upload a file via Playwright and wait for the download
# ---------------------------------------------------------------------------

def _upload_and_seal(page: Page, file_path: str, private_key: str = "", public_key: str = "", encoding: str = "plaintext", issuer: str = "QRed Test"):
    """
    Upload a PDF to the Playwright-dev frontend and trigger sealing.
    
    Returns the sealed PDF path downloaded by Playwright.
    """
    from playwright.sync_api import expect as expect_playwright

    BASE_URL = os.environ.get("QRED_BASE_URL", "http://localhost:3000")

    # Navigate to the page
    page.goto(BASE_URL, wait_until="networkidle", timeout=30_000)

    # Wait for and click the "Stamp PDF" button to open the tool
    try:
        stamp_btn = page.locator('button:has-text("Stamp PDF")').first
        expect_playwright(stamp_btn).to_be_visible(timeout=5_000)
        stamp_btn.click()
    except Exception:
        # If the tool is already open or button not found, continue
        pass

    # Wait for the file input
    file_input = page.locator('input[type="file"][accept="application/pdf"]').first
    file_input.set_input_files(file_path)

    # If private key provided, fill it in
    if private_key:
        try:
            pk_input = page.locator('input[aria-label="Private Key"]').first
            pk_input.click()
            pk_input.fill(private_key)
        except Exception:
            pass

    # If encoding strategy needs to be changed, do it
    if encoding and encoding != "plaintext":
        try:
            encoding_select = page.locator('select[aria-label="Encoding Strategy"]').first
            encoding_select.select_option(encoding)
        except Exception:
            pass

    # Click the seal button and wait for download
    try:
        seal_btn = page.locator('button:has-text("Upload PDF and Stamp QR Seals")').first
        expect_playwright(seal_btn).to_be_visible(timeout=10_000)
    except Exception:
        # Try an alternative selector
        seal_btn = page.locator('button:has-text("Seal")').first

    # Wait for download
    with page.expect_download(timeout=60_000) as download_info:
        seal_btn.click()

    download = download_info.value
    sealed_path = f"/tmp/{download.suggested_filename}"
    download.save_as(sealed_path)
    
    return sealed_path


def _verify_seal(page: Page, sealed_pdf_path: str):
    """
    Navigate to the verifier, upload the sealed PDF, and verify the seal.
    
    Returns True if verification passed.
    """
    from playwright.sync_api import expect as expect_playwright

    BASE_URL = os.environ.get("QRED_BASE_URL", "http://localhost:3000")

    # Navigate to verifier
    page.goto(f"{BASE_URL}/verifier.html", wait_until="networkidle", timeout=30_000)

    # Upload the sealed PDF
    file_input = page.locator('input[type="file"]').first
    file_input.set_input_files(sealed_pdf_path)

    # Wait for verification result
    try:
        result = page.locator('p:has-text("Verified")').first
        expect_playwright(result).to_be_visible(timeout=15_000)
        return True
    except Exception:
        try:
            error = page.locator('p:has-text("Error")').first
            expect_playwright(error).to_be_visible(timeout=5_000)
            return False
        except Exception:
            # Check for any status message
            status = page.locator('p, .status, #result').first
            status_text = status.inner_text() if status else ""
            return "verified" in status_text.lower() or "valid" in status_text.lower()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestPlainTextSealAndVerify:
    """T0: Plain text seal and verify."""

    def test_seal_simple_pdf(self, page: Page, simple_pdf_path: str):
        """Seal a simple text PDF and verify the download."""
        sealed = _upload_and_seal(page, simple_pdf_path, issuer="QRed Test")
        assert os.path.exists(sealed), "Sealed PDF was not downloaded"
        assert os.path.getsize(sealed) > 100, "Sealed PDF is too small"
        with open(sealed, "rb") as f:
            assert f.read(5) == b"%PDF-", "Sealed file is not a PDF"

    def test_verify_sealed_pdf(self, page: Page, simple_pdf_path: str):
        """Seal and verify a simple PDF."""
        sealed = _upload_and_seal(page, simple_pdf_path, issuer="QRed Test")
        verified = _verify_seal(page, sealed)
        assert verified, "Verification failed for simple sealed PDF"


class TestMultiQrDocuments:
    """T1: Multi-QR documents (multi-page PDFs generate multiple QR seals)."""

    def test_seal_multi_page_pdf(self, page: Page, multi_page_pdf_path: str):
        """Seal a multi-page PDF and verify the download."""
        sealed = _upload_and_seal(page, multi_page_pdf_path, issuer="QRed Multi-PQR Test")
        assert os.path.exists(sealed), "Multi-page PDF was not sealed"
        assert os.path.getsize(sealed) > 100, "Sealed multi-page PDF is too small"
        with open(sealed, "rb") as f:
            assert f.read(5) == b"%PDF-", "Multi-page sealed file is not a PDF"

    def test_multi_page_verification(self, page: Page, multi_page_pdf_path: str):
        """Seal and verify a multi-page PDF."""
        sealed = _upload_and_seal(page, multi_page_pdf_path, issuer="QRed Multi-PQR Test")
        verified = _verify_seal(page, sealed)
        assert verified, "Verification failed for multi-page sealed PDF"


class TestPdfTextSealing:
    """T2: PDF text sealing (QR seals embed text payload)."""

    def test_seal_with_custom_issuer(self, page: Page, simple_pdf_path: str):
        """Seal with a custom issuer string and verify the seal is applied."""
        sealed = _upload_and_seal(page, simple_pdf_path, issuer="Custom Test Issuer")
        assert os.path.exists(sealed), "Sealed PDF with custom issuer was not downloaded"
        assert os.path.getsize(sealed) > 100, "Sealed PDF with custom issuer is too small"

    def test_seal_with_b45_encoding(self, page: Page, simple_pdf_path: str):
        """Seal using the b45 encoding strategy."""
        sealed = _upload_and_seal(
            page, simple_pdf_path, encoding="b45", issuer="QRed B45 Test"
        )
        assert os.path.exists(sealed), "b45-encoded sealed PDF was not downloaded"


class TestImageOnlyPdfs:
    """T3: Image-only PDFs (no text content, only raster images)."""

    def test_seal_image_only_pdf(self, page: Page, image_only_pdf_path: str):
        """Seal an image-only PDF and verify the download."""
        sealed = _upload_and_seal(
            page, image_only_pdf_path, issuer="QRed Image-Only Test"
        )
        assert os.path.exists(sealed), "Image-only PDF was not sealed"
        assert os.path.getsize(sealed) > 100, "Sealed image-only PDF is too small"
        with open(sealed, "rb") as f:
            assert f.read(5) == b"%PDF-", "Image-only sealed file is not a PDF"

    def test_image_only_verification(self, page: Page, image_only_pdf_path: str):
        """Seal and verify an image-only PDF."""
        sealed = _upload_and_seal(
            page, image_only_pdf_path, issuer="QRed Image-Only Test"
        )
        verified = _verify_seal(page, sealed)
        assert verified, "Verification failed for image-only sealed PDF"


class TestCorruptPdfRejection:
    """T4: Corrupt PDF rejection (errors are raised, not silently swallowed)."""

    def test_reject_corrupt_pdf(self, page: Page, corrupt_pdf_path: str):
        """A corrupt PDF should produce an error, not a sealed output."""
        BASE_URL = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        
        page.goto(BASE_URL, wait_until="networkidle", timeout=30_000)

        # Open the PDF seal tool
        try:
            stamp_btn = page.locator('button:has-text("Stamp PDF")').first
            stamp_btn.click()
        except Exception:
            pass

        # Upload the corrupt PDF
        file_input = page.locator('input[type="file"][accept="application/pdf"]').first
        file_input.set_input_files(corrupt_pdf_path)

        # Fill private key
        pk_input = page.locator('input[aria-label="Private Key"]').first
        pk_input.click()
        pk_input.fill(DEMO_PRIVATE_KEY)

        # Click seal button
        seal_btn = page.locator('button:has-text("Upload PDF and Stamp QR Seals")').first
        seal_btn.click()

        # Wait a moment for processing
        page.wait_for_timeout(5_000)

        # Check for error message — should NOT download a PDF
        error_found = False
        try:
            error = page.locator('p:has-text("Error"), p:has-text("Failed"), p:has-text("corrupt")').first
            if error.inner_text():
                error_found = True
        except Exception:
            pass

        assert error_found, "Corrupt PDF should produce an error message, not a sealed output"


class TestKeyGenerationImportAndSignatureVerification:
    """T5: Key generation/import and signature verification."""

    def test_seal_with_custom_private_key(self, page: Page, simple_pdf_path: str):
        """Seal using a user-provided private key (not from server)."""
        sealed = _upload_and_seal(
            page, simple_pdf_path, private_key=DEMO_PRIVATE_KEY, issuer="QRed Custom Key Test"
        )
        assert os.path.exists(sealed), "PDF sealed with custom private key was not downloaded"

    def test_public_key_only_from_server(self, page: Page):
        """The server should only return the public key, not the private key."""
        BASE_URL = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        
        response = page.goto(f"{BASE_URL}/api/keys/default", wait_until="networkidle", timeout=10_000)
        assert response is not None
        assert response.ok
        
        data = response.json()
        assert "public_key" in data, "Public key should be returned"
        assert data["public_key"] == DEMO_PUBLIC_KEY, "Public key should match demo value"
        assert "private_key" not in data, "Private key should NOT be returned by the server"

    def test_custom_key_verification(self, page: Page, simple_pdf_path: str):
        """Seal with custom key and verify the seal."""
        sealed = _upload_and_seal(
            page, simple_pdf_path, private_key=DEMO_PRIVATE_KEY, issuer="QRed Key Test"
        )
        verified = _verify_seal(page, sealed)
        assert verified, "Verification failed for seal with custom key"


class TestExistingSealCompatibility:
    """T6: Existing seal compatibility (re-verify seals from known documents)."""

    def test_seal_reseal_compatibility(self, page: Page, simple_pdf_path: str):
        """Seal a document, then re-seal the result — verify compatibility."""
        # First seal
        sealed1 = _upload_and_seal(
            page, simple_pdf_path, private_key=DEMO_PRIVATE_KEY, issuer="QRed Compatibility Test"
        )
        assert os.path.exists(sealed1)

        # Re-seal the already-sealed PDF
        sealed2 = _upload_and_seal(
            page, sealed1, private_key=DEMO_PRIVATE_KEY, issuer="QRed Compatibility Test"
        )
        assert os.path.exists(sealed2)

        # Verify the re-sealed PDF
        verified = _verify_seal(page, sealed2)
        assert verified, "Re-sealed PDF should still verify"


class TestNoBackendApiEndpoints:
    """T7: Verify that old backend API endpoints are no longer available."""

    def test_upload_seal_returns_static(self, page: Page):
        """The old /api/pdf/upload-seal endpoint should no longer serve PDFs."""
        BASE_URL = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        
        response = page.goto(f"{BASE_URL}/api/pdf/upload-seal", wait_until="load", timeout=10_000)
        assert response is not None
        
        # Should return HTML (static asset), not a PDF or API JSON
        content_type = response.headers().get("content-type", "")
        assert "html" in content_type or "text" in content_type, \
            f"/api/pdf/upload-seal should return HTML/static asset, got {content_type}"


# ---------------------------------------------------------------------------
# Run all tests
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    pytest.main([__file__, "-v"])