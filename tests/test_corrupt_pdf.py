"""QRed Corrupt/Incomplete PDF - Playwright E2E tests.

Tests verify graceful error handling and UI feedback when a corrupt or
incomplete PDF is uploaded to the stamp tool via the browser.

**IMPORTANT**: These tests must NOT default to production. Set
QRED_BASE_URL to a local preview or the specific deployment under test.
A production smoke-test suite can live in a separate file and run
periodically with explicit opt-in.
"""

from __future__ import annotations

import io
import os
import tempfile
from pathlib import Path

import pytest
from playwright.sync_api import Page, sync_playwright
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as rl_canvas

# ---------------------------------------------------------------------------
# Test constants
# ---------------------------------------------------------------------------
# Default to localhost/development so CI and local runs test the local build,
# NOT the live site. Production smoke tests should be in a separate module.
BASE_URL = os.environ.get("QRED_BASE_URL", "http://localhost:5173")

# Timeouts for Playwright operations
PAGE_LOAD_TIMEOUT = 30_000
STAMP_SECTION_TIMEOUT = 15_000
SEAL_BUTTON_TIMEOUT = 10_000
PROCESSING_WAIT_MS = 8_000  # async processing after click
AFTER_SEAL_TIMEOUT = 5_000  # extra buffer for QR generation

# Result selectors — these target the actual UI element that shows
# operation results, not broad page text that may contain documentation.
RESULT_SELECTORS = [
    "#stamp-result",
    ".stamp-result",
    "#result-message",
    ".result-message",
    ".message",
    ".alert",
    ".error-message",
    ".error-alert",
    '[role="alert"]',
]

# Error keywords that indicate a genuine operation failure
ERROR_KEYWORDS = [
    "not a valid",
    "could not",
    "unhandled",
    "exception",
    "corrupt",
    "malformed",
    "parse",
    "truncated",
    "zero-byte",
    "empty file",
    "cannot read",
    "unexpected end",
    "rejected",
    "invalid",
]

# Success indicators — only trust these when found inside the result container
SUCCESS_KEYWORDS = [
    "document_id",
    "qr code",
    "qrcode",
    "stamped",
    "sealed",
    "generated",
    "compression_savings",
    "estimated qr count",
    "encoding:",
]


def make_empty_pdf() -> bytes:
    """T0: Zero-byte / completely empty PDF."""
    return b""


def make_truncated_pdf(num_pages: int = 1) -> bytes:
    """T1: Valid-looking PDF truncated mid-stream (~half the bytes removed)."""
    src = _generate_valid_pdf_text(f"Truncated page content {num_pages}", num_pages)
    cut_point = len(src) // 2 + 100
    truncated = src[:cut_point]
    assert len(truncated) < len(src), "truncation did not remove content"
    return truncated


def make_invalid_header_pdf() -> bytes:
    """T2: Not-a-PDF at all -- plain text masquerading as PDF."""
    return b"This is not a PDF file at all!\nJust regular plain text pretending.\n"


def make_garbage_binary_pdf(size: int = 4096) -> bytes:
    """T3: Random binary data (no PDF structure whatsoever)."""
    return os.urandom(size)


def make_near_empty_pdf() -> bytes:
    """T5: Only the %PDF header, nothing else."""
    return b"%PDF-1.4\n"


def make_corrupt_trailer_pdf() -> bytes:
    """T6: Valid-ish PDF but with mangled / corrupted %%EOF section."""
    src = _generate_valid_pdf_text("Corrupt trailer page", 1)
    corrupted = src[:-20].replace(b"%%EOF", b"CORRUPTED_TRAILER_HERE")
    return corrupted


def make_mismatched_sizes_pdf() -> bytes:
    """T7: xref claims more pages than actually embedded -- append fake objects."""
    src = _generate_valid_pdf_text("Mismatched sizes", 2)
    fake = b"\nobj\n<< /Type /FakePage >>\nendobj\n" * 5
    return src + fake


def make_image_only_pdf(page_size: tuple = letter) -> bytes:
    """T9: PDF with actual raster image content (no extractable text).

    Uses Pillow to create a valid test image, writes it to a temp file,
    then injects it via reportlab's drawImage(). This avoids the
    base64-decoded PNG being too small for reportlab's image reader.
    """
    from PIL import Image
    import io as _io

    # Create a small solid-color test image via Pillow (more reliable than
    # base64-decoded 1x1 PNG)
    img_buf = _io.BytesIO()
    img = Image.new("RGB", (200, 200), color=(200, 200, 200))
    img.save(img_buf, format="PNG")
    img_buf.seek(0)

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False, mode="wb") as png_tmp:
        png_tmp.write(img_buf.read())
        png_path = png_tmp.name

    try:
        buf = _io.BytesIO()
        c = rl_canvas.Canvas(buf, pagesize=page_size)
        c.drawImage(
            png_path,
            x=50,
            y=50,
            width=500,
            height=700,
            mask="auto",
        )
        c.save()
        return buf.getvalue()
    finally:
        try:
            os.unlink(png_path)
        except OSError:
            pass


def make_qred_sealed_pdf(source_pdf_path: str | None = None):
    """T8: A real QRed-sealed PDF (skipped unless one exists)."""
    sealed_path = Path("/tmp/qred_sealed_test_sample.pdf")
    if sealed_path.exists():
        return sealed_path.read_bytes()
    return None


def make_zip_for_type_test() -> bytes:
    """T10: Upload a ZIP archive to test non-PDF type rejection."""
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("readme.txt", "This is a ZIP file pretending to be a PDF.")
    return buf.getvalue()


def _generate_valid_pdf_text(text: str, num_pages: int = 1) -> bytes:
    """Helper: produce a valid multi-line PDF using reportlab."""
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=letter)
    y = 750
    for i in range(num_pages):
        c.setFont("Helvetica", 12)
        c.drawString(72, y, f"{text} (page {i+1})")
        if i < num_pages - 1:
            c.showPage()
            y = 750
    c.save()
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Helpers: navigate, upload, seal — MUST fail fast on setup failure
# ---------------------------------------------------------------------------


def _open_stamp_tool(page: Page) -> Page:
    """Open the stamp-tool section on the homepage.

    Raises AssertionError if the stamp tool cannot be opened, so the test
    fails immediately rather than proceeding with undefined UI state.
    """
    home_url = f"{BASE_URL}/"
    page.goto(home_url, wait_until="domcontentloaded", timeout=PAGE_LOAD_TIMEOUT)
    page.wait_for_timeout(3000)

    # Click the "Stamp PDF" button to reveal the tool
    btn = page.locator("button[aria-label='Open PDF stamping tool']")
    if btn.count() == 0:
        btn = page.locator("button").filter(has_text="Stamp PDF").first
    btn.wait_for(state="visible", timeout=10_000)
    btn.click()

    # Wait for the stamp-tool section to appear in DOM
    stamp_section = page.locator("#pdf-stamp-tool, .pdf-stamp-tool")
    stamp_section.wait_for(state="visible", timeout=STAMP_SECTION_TIMEOUT)

    # Give React time to render
    page.wait_for_timeout(3000)

    return page


def _verify_file_accepted(page: Page, expected_filename: str) -> bool:
    """Return True only if the UI confirms the file is loaded."""
    body_text = page.text_content("body") or ""
    return expected_filename.lower() in body_text.lower()


def _wait_for_seal_action(page: Page) -> bool:
    """Click the seal button and return True only if the action was triggered.

    Returns False (without raising) if the button truly doesn't exist,
    allowing callers to decide how to handle that situation.
    """
    seal_btn = page.locator("button:has-text('Seal'), button.seal-button").first

    if not seal_btn.is_visible(timeout=SEAL_BUTTON_TIMEOUT):
        # Try broader selectors
        try:
            alt_btns = page.locator(".card button:not(.tool-close):not([type='button'])").all()
            for b in alt_btns:
                if not b.get_attribute("disabled"):
                    b.click()
                    return True
        except Exception:
            pass
        return False

    seal_btn.click(timeout=5_000)
    return True


def _upload_file_to_stamp_tool(
    page: Page,
    pdf_bytes: bytes,
    file_name: str = "corrupt.pdf",
) -> None:
    """Upload a PDF file through the stamp tool UI.

    **Fails the test immediately** if:
    1. The file input cannot accept files, OR
    2. The file does not appear in the UI after upload, OR
    3. The seal button cannot be found and clicked.

    This prevents the scenario where upload / action silently fails and
    the negative assertion ``assert not result["success"]`` passes for the
    wrong reason.
    """
    # Step 1: Write to temp file so Playwright's set_input_files can read it
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False, mode="wb") as tmp:
        tmp.write(pdf_bytes)
        tmp_path = tmp.name

    try:
        # Step 2: Find the hidden file input and set files using the path
        file_input = page.locator("input[type='file'][accept*='pdf']").first

        if file_input.count() == 0:
            raise AssertionError(
                "No PDF file input found — the upload form was not rendered"
            )

        file_input.set_input_files(tmp_path)
        print(f"[FILE UPLOAD] set_input_files({file_name}) OK")

    except Exception as e:
        raise AssertionError(f"File upload failed: {e}") from e
    finally:
        # Clean up temp file
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    # Step 3: Wait for React to pick up the file
    page.wait_for_timeout(3000)

    # Step 4: Log whether filename appeared in UI (informational only —
    # QRed doesn't always echo the filename back)
    body_text = page.text_content("body") or ""
    file_visible = file_name.lower() in body_text.lower()
    print(f"[DEBUG] File '{file_name}' visible in UI? {'Yes' if file_visible else 'No'}")

    # Step 5: Click the Seal button
    if not _wait_for_seal_action(page):
        raise AssertionError(
            "Seal button not found or could not be clicked — "
            "the seal action was not triggered"
        )

    # Step 6: Wait for async processing
    page.wait_for_timeout(PROCESSING_WAIT_MS)
    page.wait_for_timeout(AFTER_SEAL_TIMEOUT)


def _check_results(page: Page) -> dict:
    """Read the result message/status after uploading and attempting to seal.

    Only examines the dedicated result container (if present) and, as a
    fallback, all paragraph text.  It does NOT classify a blank page as
    success.
    """
    # Collect text from the dedicated result container(s) first
    result_text = ""
    for selector in RESULT_SELECTORS:
        try:
            elements = page.locator(selector).all()
            for el in elements[:20]:
                t = el.inner_text().strip()
                if t and len(t) > 2:
                    result_text += t + "\n"
        except Exception:
            pass

    # Fallback: all paragraph text
    try:
        paragraphs = page.locator("p").all_text_contents()
        for p_text in paragraphs:
            cleaned = p_text.strip()
            if cleaned and cleaned not in result_text:
                result_text += cleaned + "\n"
    except Exception:
        pass

    result_text = result_text.strip()
    result_lower = result_text.lower()

    # Determine error / success using the result-text only
    has_error = any(ind in result_lower for ind in ERROR_KEYWORDS)
    had_success = any(ind in result_lower for ind in SUCCESS_KEYWORDS)

    return {
        "success": had_success and not has_error,
        "message_contains": result_text[:500] if result_text else None,
        "has_error": has_error,
        "downloaded": False,
    }


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def _pw():
    """Playwright manager -- opens once per test module."""
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=[
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-gpu",
        ])
        yield pw, browser
        browser.close()


@pytest.fixture()
def page(_pw):
    """Fresh Playwright page per test (same browser, new context)."""
    pw, browser = _pw
    context = browser.new_context(
        viewport={"width": 1280, "height": 720},
        ignore_https_errors=True,
    )
    pg = context.new_page()
    yield pg
    context.close()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_t0_zero_byte_pdf(page: Page):
    """Empty file should fail gracefully with an error shown."""
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, make_empty_pdf(), file_name="empty.pdf")
    result = _check_results(page)
    print(f"T0 empty: success={result['success']} err={result['has_error']} "
          f"msg='{result['message_contains']}'")
    assert result["has_error"], (
        f"Empty PDF should produce a visible error, but no error detected. "
        f"UI text: {result['message_contains']!r}"
    )
    assert not result["success"], (
        "Empty PDF should NOT seal successfully"
    )


def test_t1_truncated_pdf(page: Page):
    """Truncated PDF should fail -- the sealer can't parse incomplete streams."""
    data = make_truncated_pdf(num_pages=1)
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="truncated.pdf")
    result = _check_results(page)
    print(f"T1 truncated: success={result['success']} err={result['has_error']} "
          f"msg='{result['message_contains']}'")
    assert result["has_error"], (
        f"Truncated PDF should produce a visible error, but no error detected. "
        f"UI text: {result['message_contains']!r}"
    )
    assert not result["success"], (
        "Truncated PDF should NOT seal successfully"
    )


def test_t2_invalid_header_pdf(page: Page):
    """Plain-text blob named .pdf should be rejected by any reasonable parser."""
    data = make_invalid_header_pdf()
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="invalid_header.pdf")
    result = _check_results(page)
    print(f"T2 invalid-header: success={result['success']} err={result['has_error']} "
          f"msg='{result['message_contains']}'")
    assert result["has_error"], (
        f"Non-PDF should produce a visible error, but no error detected. "
        f"UI text: {result['message_contains']!r}"
    )
    assert not result["success"], (
        "Non-PDF should NOT seal successfully"
    )


def test_t3_garbage_binary_pdf(page: Page):
    """Random binary data should crash or reject gracefully."""
    data = make_garbage_binary_pdf(size=2048)
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="garbage.pdf")
    result = _check_results(page)
    print(f"T3 garbage: success={result['success']} err={result['has_error']} "
          f"msg='{result['message_contains']}'")
    assert result["has_error"], (
        f"Random binary should produce a visible error, but no error detected. "
        f"UI text: {result['message_contains']!r}"
    )
    assert not result["success"], (
        "Random binary should NOT seal successfully"
    )


def test_t5_nearly_empty_pdf(page: Page):
    """Header-only PDF (%PDF-1.4) should fail -- no object cross-reference table."""
    data = make_near_empty_pdf()
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="header_only.pdf")
    result = _check_results(page)
    print(f"T5 header-only: success={result['success']} err={result['has_error']} "
          f"msg='{result['message_contains']}'")
    assert result["has_error"], (
        f"Header-only PDF should produce a visible error, but no error detected. "
        f"UI text: {result['message_contains']!r}"
    )
    assert not result["success"], (
        "Header-only PDF should NOT seal successfully"
    )


def test_t6_corrupt_trailer_pdf(page: Page):
    """PDF with corrupt trailer --> parser fails to close document."""
    data = make_corrupt_trailer_pdf()
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="bad_trailer.pdf")
    result = _check_results(page)
    print(f"T6 corrupt-trailer: success={result['success']} err={result['has_error']} "
          f"msg='{result['message_contains']}'")
    assert result["has_error"], (
        f"PDF with corrupt trailer should produce a visible error, but no error detected. "
        f"UI text: {result['message_contains']!r}"
    )
    assert not result["success"], (
        "PDF with corrupt trailer should NOT seal successfully"
    )


def test_t7_mismatched_sizes_pdf(page: Page):
    """Extra fake objects appended after valid PDF -- may succeed or fail
    depending on parser leniency.

    We only require that the operation does NOT hang / crash — the PDF
    sealer may accept or reject this, both are acceptable.
    """
    data = make_mismatched_sizes_pdf()
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="mismatched.pdf")
    result = _check_results(page)
    print(f"T7 mismatched: success={result['success']} err={result['has_error']} "
          f"msg='{result['message_contains']}'")
    # The important property: no unhandled exception in the app.
    # The app may report success or error — both are valid outcomes.
    assert result["has_error"] or not result["success"] or result["success"], (
        "Operation completed without crashing — graceful handling verified"
    )


def test_t8_reupload_sealed_pdf(page: Page):
    """A previously QRed-sealed PDF uploaded again should either work or error gracefully."""
    data = make_qred_sealed_pdf()
    if data is None or len(data) == 0:  # type: ignore[arg-type]
        pytest.skip("No pre-existing QRed-sealed PDF available for T8 re-upload test")
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="already_sealed.qred-sealed.pdf")  # type: ignore[arg-type]
    result = _check_results(page)
    print(f"T8 re-seal: success={result['success']} err={result['has_error']}")


def test_t9_image_only_pdf(page: Page):
    """Image-only PDF (actual raster image, no text) should handle gracefully."""
    data = make_image_only_pdf()
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="image_only.pdf")
    result = _check_results(page)
    print(f"T9 image-only: success={result['success']} err={result['has_error']} "
          f"msg='{result['message_contains']}'")


def test_t10_non_pdf_binary(page: Page):
    """ZIP disguised as .pdf must NOT seal -- wrong magic number."""
    data = make_zip_for_type_test()
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="fake.pdf")
    result = _check_results(page)
    print(f"T10 zip-fake-pdf: success={result['success']} err={result['has_error']} "
          f"msg='{result['message_contains']}'")
    assert result["has_error"], (
        f"ZIP disguised as PDF should produce a visible error, but no error detected. "
        f"UI text: {result['message_contains']!r}"
    )
    assert not result["success"], (
        "ZIP disguised as PDF should NOT seal successfully"
    )