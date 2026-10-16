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
import json
import base64
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
# This matches the public demo verification key in the worker.
DEMO_PUBLIC_KEY = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q="

# The demo private key used for sealing in tests.
DEMO_PRIVATE_KEY = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes="

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

# The demo public key — matches the hardcoded verification value in the worker
DEMO_PUBLIC_KEY = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q="

# A deliberately public demo seed for in-browser sealing.
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

    # Enable test-mode flag so App.jsx exposes seal data for E2E verification
    page.add_init_script("__qredTestMode = true;")

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

    # Signing keys are local; opening the tool no longer fetches a default pair.
    expect_playwright(page.get_by_role("button", name="Generate key pair", exact=True)).to_be_enabled()

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
        seal_button = page.locator('button:has-text("Stamp and save PDF")').first
        expect_playwright(seal_button).to_be_enabled(timeout=5_000)
    except Exception as exc:
        raise AssertionError(f"Failed to fill private key or wait for seal button: {exc}") from exc

    page.get_by_label("Issuer", exact=True).fill(issuer)
    page.get_by_label("Public Key", exact=True).fill(public_key or DEMO_PUBLIC_KEY)

    # If encoding strategy needs to be changed, verify it was selected
    if encoding:
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
        seal_btn = page.locator('button:has-text("Stamp and save PDF")').first
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
    result = page.evaluate(
        "(args) => window.__qredTestVerify(args.sealStrings, args.publicKey)",
        {"sealStrings": seal_payload, "publicKey": public_key or ""},
    )

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
        assert seal_result["full_result"]["issuer"] == "Custom Test Issuer"

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
    """Image-only pages must not receive a signature over empty text."""

    def test_refuses_image_only_pdf(self, page: Page, image_only_pdf_path: str):
        base_url = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        page.goto(base_url, wait_until="networkidle")
        page.get_by_role("button", name="Open PDF stamping tool").click()
        expect(page.get_by_role("button", name="Generate key pair")).to_be_enabled()
        page.get_by_label("Open PDF", exact=True).set_input_files(image_only_pdf_path)
        page.get_by_label("Private Key", exact=True).fill(DEMO_PRIVATE_KEY)
        page.get_by_label("Public Key", exact=True).fill(DEMO_PUBLIC_KEY)
        downloads = []
        page.on("download", lambda download: downloads.append(download))
        page.get_by_role("button", name="Stamp and save PDF", exact=True).click()
        expect(page.get_by_text("PDF sealing failed: No readable text", exact=False)).to_be_visible()
        assert not downloads, "An unreadable PDF must not produce a sealed download"


class TestPdfExtractionIntegrity:
    def test_cjk_text_survives_browser_sealing(self, page: Page):
        source = str(Path(__file__).parent / "fixtures" / "cjk-text.pdf")
        sealed, seal_result = _upload_and_seal(page, source, private_key=DEMO_PRIVATE_KEY)
        assert os.path.exists(sealed)
        content = json.loads(seal_result["full_result"]["payload_json"])["content"]
        assert "Invoice 123" in content
        assert "承認金額は一万円です" in content
        assert _verify_seal_with_seal_strings(page, seal_result, seal_result["document_id"], DEMO_PUBLIC_KEY)
        expect(page.locator("#resultContent")).to_contain_text("承認金額は一万円です")

    def test_missing_cmap_cannot_sign_partial_text(self, browser):
        # Block service workers so this deliberately failed request cannot be
        # satisfied by a previous offline cache entry.
        with browser.new_context(service_workers="block") as context:
            blocked = []

            def fail_cmap(route):
                blocked.append(route.request.url)
                route.abort()

            context.route("**/pdfjs/**/cmaps/**", fail_cmap)
            page = context.new_page()
            source = str(Path(__file__).parent / "fixtures" / "cjk-text.pdf")
            self._assert_rejected(page, source, "Cannot reliably read all text")
            assert blocked, "The test must actually fail a character-map request"

    def test_filled_form_is_flattened_before_sealing(self, page: Page, tmp_path):
        source = tmp_path / "filled-form.pdf"
        pdf = rl_canvas.Canvas(str(source), pagesize=letter)
        pdf.drawString(72, 700, "Invoice amount:")
        pdf.acroForm.textfield(name="amount", value="12345.67 dollars", x=180, y=690, width=200, height=25)
        pdf.showPage()
        pdf.save()
        sealed, seal_result = _upload_and_seal(page, str(source), private_key=DEMO_PRIVATE_KEY)
        assert os.path.exists(sealed)
        expect(page.locator("#stamp-result")).to_contain_text("Flattened 1 form field(s) before sealing.")
        content = json.loads(seal_result["full_result"]["payload_json"])["content"]
        assert "12345.67 dollars" in content
        assert _verify_seal_with_seal_strings(page, seal_result, seal_result["document_id"], DEMO_PUBLIC_KEY)
        expect(page.locator("#resultContent")).to_contain_text("12345.67 dollars")

    def test_stale_form_appearance_is_rejected(self, page: Page, tmp_path):
        source = tmp_path / "stale-form.pdf"
        pdf = rl_canvas.Canvas(str(source), pagesize=letter)
        pdf.drawString(72, 700, "Invoice amount:")
        pdf.acroForm.textfield(name="amount", value="12345.67 dollars", x=180, y=690, width=200, height=25)
        pdf.showPage()
        pdf.save()
        data = source.read_bytes()
        assert data.count(b"/V (12345.67 dollars)") == 1
        # Same byte length keeps the xref valid while changing only the stored
        # value, leaving the compressed visible appearance at the old amount.
        source.write_bytes(data.replace(b"/V (12345.67 dollars)", b"/V (99999.99 dollars)"))
        self._assert_rejected(page, str(source), "saved appearance that does not match its value")

    @staticmethod
    def _assert_rejected(page, source, message):
        base_url = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        page.goto(base_url, wait_until="networkidle")
        page.get_by_role("button", name="Open PDF stamping tool").click()
        expect(page.get_by_role("button", name="Generate key pair", exact=True)).to_be_enabled()
        page.get_by_label("Open PDF", exact=True).set_input_files(source)
        page.get_by_label("Private Key", exact=True).fill(DEMO_PRIVATE_KEY)
        page.get_by_label("Public Key", exact=True).fill(DEMO_PUBLIC_KEY)
        downloads = []
        page.on("download", lambda download: downloads.append(download))
        page.get_by_role("button", name="Stamp and save PDF", exact=True).click()
        expect(page.locator("#stamp-result")).to_contain_text(message, timeout=30_000)
        assert not downloads, "Rejected PDF must not produce a signed download"


class TestKeyGenerationImportAndSignatureVerification:
    """T4: Key generation/import and signature verification."""

    @pytest.mark.parametrize("viewport_width", [1280, 390], ids=["desktop", "mobile"])
    def test_demo_button_stamps_and_verifies_with_default_key(self, page: Page, simple_pdf_path: str, tmp_path, viewport_width):
        """Use the demo button, then verify in this tab and a fresh default verifier."""
        # Vite preview has no Worker runtime. Serve the real Worker's response
        # at its normal endpoint so fresh verifier defaults are covered too.
        defaults = json.loads(subprocess.check_output([
            "node", "--input-type=module", "-e",
            "import worker from './frontend/worker/index.js'; "
            "const response = await worker.fetch(new Request('https://qred.org/api/keys/default'), {}); "
            "process.stdout.write(await response.text());",
        ], cwd=Path(__file__).resolve().parents[1], text=True))
        page.route("**/api/keys/default", lambda route: route.fulfill(json=defaults))
        page.set_viewport_size({"width": viewport_width, "height": 844})
        page.add_init_script("window.__qredTestMode = true;")
        base_url = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        page.goto(base_url, wait_until="networkidle")
        expect(page.get_by_label("Issuer public key", exact=True)).to_have_value(defaults["public_key"])
        page.get_by_role("button", name="Open PDF stamping tool").click()
        expect(page.get_by_label("Private Key", exact=True)).to_have_value("")
        page.get_by_role("button", name="Use demo key pair", exact=True).click()
        expect(page.get_by_label("Private Key", exact=True)).to_have_attribute("type", "password")
        expect(page.get_by_label("Public Key", exact=True)).to_have_value(DEMO_PUBLIC_KEY.rstrip("="))
        expect(page.get_by_label("Issuer public key", exact=True)).to_have_value(DEMO_PUBLIC_KEY.rstrip("="))
        expect(page.locator("#signing-key-status")).to_contain_text("The verifier now uses the matching demo public key.")
        page.get_by_label("Open PDF", exact=True).set_input_files(simple_pdf_path)
        with page.expect_download(timeout=60_000) as saved:
            page.get_by_role("button", name="Stamp and save PDF", exact=True).click()
        sealed_path = tmp_path / saved.value.suggested_filename
        saved.value.save_as(sealed_path)
        assert sealed_path.read_bytes().startswith(b"%PDF-")
        seals = _extract_seal_result(page)["seal_strings"]
        assert seals
        page.locator("summary", has_text="Manual seal entry").click()
        page.get_by_label("Seal strings, one per line").fill("\n".join(seals))
        page.get_by_role("button", name="Add seals", exact=True).click()
        expect(page.get_by_role("heading", name="VALID", exact=True)).to_be_visible()
        expect(page.locator(".verification-result pre")).to_contain_text("Testing client-side sealing")

        # Neither verifier needs a pasted key or the "Use public key to verify"
        # action. A fresh standalone page selects the matching default after
        # reading the seal's key ID.
        page.goto(f"{base_url}/verifier.html", wait_until="networkidle")
        expect(page.get_by_label("Issuer public key", exact=True)).to_have_value("")
        page.get_by_label("Seal text", exact=True).fill("\n".join(seals))
        page.get_by_role("button", name="Add Manual Seals", exact=True).click()
        expect(page.locator("#resultStatus")).to_have_text("VALID")
        expect(page.get_by_label("Issuer public key", exact=True)).to_have_value(defaults["public_key"])
        expect(page.locator("#resultContent")).to_contain_text("Testing client-side sealing")

    @pytest.mark.parametrize("viewport_width", [1280, 390], ids=["desktop", "mobile"])
    def test_generate_download_restore_stamp_and_verify(self, page: Page, simple_pdf_path: str, tmp_path, viewport_width):
        """Generate in a real browser, reuse the downloaded seed, and verify a stamped PDF."""
        import re

        page.set_viewport_size({"width": viewport_width, "height": 844})
        page.add_init_script("window.__qredTestMode = true;")
        base_url = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        page.goto(base_url, wait_until="networkidle")
        page.get_by_role("button", name="Open PDF stamping tool").click()
        private_input = page.get_by_label("Private Key", exact=True)
        public_input = page.get_by_label("Public Key", exact=True)
        expect(private_input).to_have_value("")
        expect(public_input).to_have_value("")

        # No request should be needed for generation or key downloads.
        requests = []
        page.on("request", lambda request: requests.append(request))
        page.get_by_role("button", name="Generate key pair", exact=True).click()
        expect(page.locator("#signing-key-status")).to_contain_text("Key pair generated.")
        generated_private = private_input.input_value()
        generated_public = public_input.input_value()
        assert re.fullmatch(r"[A-Za-z0-9_-]{43}", generated_private)
        assert re.fullmatch(r"[A-Za-z0-9_-]{43}", generated_public)
        expect(private_input).to_have_attribute("type", "password")

        for kind, expected in [("private", generated_private), ("public", generated_public)]:
            with page.expect_download() as download_info:
                page.get_by_role("button", name=f"Save {kind} key", exact=True).click()
            download = download_info.value
            assert download.suggested_filename == f"qred-ed25519-{kind}-key.txt"
            path = tmp_path / download.suggested_filename
            download.save_as(path)
            assert path.read_text().strip() == expected
        assert generated_private not in (tmp_path / "qred-ed25519-public-key.txt").read_text()
        assert not requests, "Key generation and downloads must stay local"
        assert page.evaluate("JSON.stringify([localStorage, sessionStorage])").find(generated_private) == -1

        # Closing clears the keys. The private download restores the same identity.
        page.get_by_role("button", name="Close", exact=True).click()
        page.get_by_role("button", name="Open PDF stamping tool").click()
        expect(private_input).to_have_value("")
        expect(public_input).to_have_value("")
        page.get_by_label("Open private key file", exact=True).set_input_files(tmp_path / "qred-ed25519-private-key.txt")
        expect(page.locator("#signing-key-status")).to_contain_text("Private key opened. Matching public key derived.")
        expect(private_input).to_have_value(generated_private)
        expect(private_input).to_have_attribute("type", "password")
        expect(public_input).to_have_value(generated_public)
        page.get_by_label("Open public key file", exact=True).set_input_files(tmp_path / "qred-ed25519-public-key.txt")
        expect(page.locator("#signing-key-status")).to_contain_text("Public key opened from your device.")
        page.get_by_label("Open issuer public key file", exact=True).set_input_files(tmp_path / "qred-ed25519-public-key.txt")
        expect(page.get_by_label("Issuer public key", exact=True)).to_have_value(generated_public)

        page.get_by_label("Open PDF", exact=True).set_input_files(simple_pdf_path)
        page.get_by_label("Issuer", exact=True).fill("Generated Key Test")
        with page.expect_download(timeout=60_000) as download_info:
            page.get_by_role("button", name="Stamp and save PDF", exact=True).click()
        sealed_path = tmp_path / download_info.value.suggested_filename
        download_info.value.save_as(sealed_path)
        assert sealed_path.read_bytes().startswith(b"%PDF-")
        seal_result = _extract_seal_result(page)
        assert seal_result["seal_strings"]
        page.locator("summary", has_text="Manual seal entry").click()
        page.get_by_label("Seal strings, one per line").fill("\n".join(seal_result["seal_strings"]))
        page.get_by_role("button", name="Add seals", exact=True).click()
        expect(page.get_by_role("heading", name="VALID", exact=True)).to_be_visible()
        expect(page.locator(".verification-result pre")).to_contain_text("Testing client-side sealing")
        for request in requests:
            assert generated_private not in request.url
            assert generated_private not in (request.post_data or "")

        # The standalone verifier accepts the same public-key file from an issuer.
        page.goto(f"{base_url}/verifier.html", wait_until="networkidle")
        page.get_by_label("Open issuer public key file", exact=True).set_input_files(tmp_path / "qred-ed25519-public-key.txt")
        expect(page.get_by_label("Issuer public key", exact=True)).to_have_value(generated_public)
        page.get_by_label("Seal text", exact=True).fill("\n".join(seal_result["seal_strings"]))
        page.get_by_role("button", name="Add Manual Seals", exact=True).click()
        expect(page.locator("#resultStatus")).to_have_text("VALID")
        expect(page.locator("#resultContent")).to_contain_text("Testing client-side sealing")

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


def _invoice_camera_pixels(damaged=False):
    fixture = Path(__file__).parent / "fixtures" / "qr-scans" / "invoice-footer-300dpi.png"
    pixels = fixture.read_bytes()
    if not damaged:
        return pixels
    if not PIL_AVAILABLE:
        pytest.skip("Pillow not installed")
    with Image.open(pillow_io.BytesIO(pixels)) as image:
        image = image.convert("RGBA")
        # Version 35-H, module (row 98, column 126): the high bit of the
        # hidden length field. jsQR can correct this; raw sampling cannot.
        image.paste((255, 255, 255, 255), (627, 572, 632, 578))
        buffer = pillow_io.BytesIO()
        image.save(buffer, format="PNG")
        return buffer.getvalue()


class TestRenderedQrImageUploads:
    """Use actual downloaded-PDF pixels, without manual strings or test hooks."""

    PUBLIC_KEY = "Sz8MZnNyHPkt6J3hC_rcXEabv4rrQSgAH_krcitjlF8"
    FIXTURES = Path(__file__).parent / "fixtures" / "qr-scans"

    @pytest.mark.parametrize("image_name", [
        "invoice-footer-300dpi.png",
        "invoice-full-300dpi.png",
        "inventory-four-inch-300dpi.png",
    ])
    def test_verifies_previously_unreadable_rendered_image(self, page: Page, image_name):
        page.goto(os.environ.get("QRED_BASE_URL", "http://localhost:3000"))
        page.get_by_label("Issuer public key", exact=True).fill(self.PUBLIC_KEY)
        page.get_by_label("Choose QR image", exact=True).set_input_files(str(self.FIXTURES / image_name))
        expect(page.get_by_role("heading", name="VALID", exact=True)).to_be_visible(timeout=20000)
        expect(page.locator(".verification-result pre")).to_contain_text("QRed PDF page integrity")
        page.get_by_label("Issuer public key", exact=True).fill(DEMO_PUBLIC_KEY)
        expect(page.get_by_role("heading", name="INVALID", exact=True)).to_be_visible()

    def test_mobile_image_upload_waits_for_both_distinct_seals(self, page: Page):
        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(os.environ.get("QRED_BASE_URL", "http://localhost:3000"))
        page.get_by_label("Issuer public key", exact=True).fill(self.PUBLIC_KEY)
        upload = page.get_by_label("Choose QR image", exact=True)
        upload.set_input_files(str(self.FIXTURES / "manifest-seal-1-300dpi.png"))
        expect(page.get_by_role("heading", name="INCOMPLETE", exact=True)).to_be_visible(timeout=20000)
        upload.set_input_files(str(self.FIXTURES / "manifest-seal-1-300dpi.png"))
        expect(page.get_by_role("heading", name="INCOMPLETE", exact=True)).to_be_visible()
        upload.set_input_files(str(self.FIXTURES / "manifest-seal-2-300dpi.png"))
        expect(page.get_by_role("heading", name="VALID", exact=True)).to_be_visible(timeout=20000)
        expect(page.locator(".verification-result pre")).to_contain_text("END OF MANIFEST - 56 synthetic line items.")

    def test_verifies_image_with_damaged_hidden_length(self, page: Page):
        page.goto(os.environ.get("QRED_BASE_URL", "http://localhost:3000"))
        page.get_by_label("Issuer public key", exact=True).fill(self.PUBLIC_KEY)
        page.get_by_label("Choose QR image", exact=True).set_input_files({
            "name": "damaged-invoice.png", "mimeType": "image/png", "buffer": _invoice_camera_pixels(damaged=True),
        })
        expect(page.get_by_role("heading", name="VALID", exact=True)).to_be_visible(timeout=20000)
        expect(page.locator(".verification-result pre")).to_contain_text("Approved total: $123.45")
        page.get_by_label("Issuer public key", exact=True).fill(DEMO_PUBLIC_KEY)
        expect(page.get_by_role("heading", name="INVALID", exact=True)).to_be_visible()


class TestCameraFrameScanning:
    """Exercise the real video/canvas/decoder path with synthetic camera pixels.

    These cover framing and verification, not physical focus, glare, or moire.
    """

    @pytest.mark.parametrize("damaged", [False, True], ids=["clean", "damaged-hidden-data"])
    @pytest.mark.parametrize("manual", [False, True], ids=["automatic", "scan-photo"])
    @pytest.mark.parametrize("width,height,left,top,size", [
        (720, 1280, 90, 180, 540),
        (1280, 720, 90, 30, 660),
    ], ids=["portrait", "landscape"])
    def test_verifies_seal_outside_center_crop(self, page: Page, manual, width, height, left, top, size, damaged):
        camera = {
            "image": "data:image/png;base64," + base64.b64encode(_invoice_camera_pixels(damaged)).decode("ascii"),
            "width": width, "height": height, "left": left, "top": top, "size": size, "manual": manual,
        }
        page.set_viewport_size({"width": 390, "height": 844} if width < height else {"width": 1280, "height": 800})
        page.add_init_script("""
        (() => {
            const camera = CAMERA_FIXTURE;
            // Freeze the scanner's cooldown clock for the button case, so
            // only Scan photo can produce the result after the blank frame.
            if (camera.manual) performance.now = () => 1000;
            Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
                enumerateDevices: async () => [],
                getUserMedia: async () => {
                    const image = new Image();
                    image.src = camera.image;
                    await image.decode();
                    const canvas = document.createElement('canvas');
                    canvas.width = camera.width;
                    canvas.height = camera.height;
                    const context = canvas.getContext('2d');
                    context.fillStyle = 'white';
                    context.fillRect(0, 0, canvas.width, canvas.height);
                    const stream = canvas.captureStream(10);
                    window.showCameraSeal = () => {
                        // Crop the existing PDF fixture with its quiet zone,
                        // then put its corners beyond the old center 50% ROI.
                        context.drawImage(image, 45, 116, 740, 740, camera.left, camera.top, camera.size, camera.size);
                        stream.getVideoTracks()[0].requestFrame();
                    };
                    return stream;
                },
            }});
        })();
        """.replace("CAMERA_FIXTURE", json.dumps(camera)))
        page.goto(os.environ.get("QRED_BASE_URL", "http://localhost:3000"))
        page.get_by_label("Issuer public key", exact=True).fill(TestRenderedQrImageUploads.PUBLIC_KEY)
        page.get_by_role("button", name="Start scanning", exact=True).click()
        page.wait_for_function("""() => {
            const video = document.querySelector('.ar-camera video');
            return video?.readyState >= 2 && video.videoWidth > 0;
        }""")
        page.locator(".ar-camera video").scroll_into_view_if_needed()
        page.evaluate("window.showCameraSeal()")
        if manual:
            page.wait_for_function("""() => {
                const video = document.querySelector('.ar-camera video');
                const canvas = document.createElement('canvas');
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                const context = canvas.getContext('2d');
                context.drawImage(video, 0, 0);
                return context.getImageData(0, 0, canvas.width, canvas.height).data.some((value, i) => i % 4 !== 3 && value < 128);
            }""", timeout=5000)
            page.get_by_role("button", name="Scan photo", exact=True).click()
        expect(page.get_by_role("heading", name="QR captured", exact=True)).to_be_visible(timeout=10000)
        expect(page.get_by_role("heading", name="VALID", exact=True)).to_be_visible()
        expect(page.locator(".verification-result pre")).to_contain_text("Approved total: $123.45")


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
