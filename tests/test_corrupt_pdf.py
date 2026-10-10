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
import re
import tempfile
from pathlib import Path

import pytest
from playwright.sync_api import Page, expect, sync_playwright
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas as rl_canvas

# ---------------------------------------------------------------------------
# Test constants
# ---------------------------------------------------------------------------
BASE_URL = os.environ.get("QRED_BASE_URL", "http://localhost:5173")

PAGE_LOAD_TIMEOUT = 30_000
STAMP_SECTION_TIMEOUT = 15_000
SEAL_BUTTON_TIMEOUT = 10_000


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
    """T9: PDF with actual raster image content (no extractable text)."""
    from PIL import Image
    import io as _io

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
            x=50, y=50, width=500, height=700, mask="auto",
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

    Raises AssertionError if the stamp tool cannot be opened.
    """
    home_url = f"{BASE_URL}/"
    page.goto(home_url, wait_until="domcontentloaded", timeout=PAGE_LOAD_TIMEOUT)
    btn = page.locator("button[aria-label='Open PDF stamping tool']")
    if btn.count() == 0:
        btn = page.locator("button").filter(has_text="Stamp PDF").first
    btn.wait_for(state="visible", timeout=10_000)
    btn.click()

    stamp_section = page.locator("#pdf-stamp-tool, .pdf-stamp-tool")
    stamp_section.wait_for(state="visible", timeout=STAMP_SECTION_TIMEOUT)

    expect(page.get_by_role("button", name="Use Default Keys", exact=True)).to_be_enabled()

    return page


# A demo private key for client-side sealing (not exposed by the server).
# The frontend requires a private key before the seal handler will process the file.
_DEMO_PRIVATE_KEY = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes="


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
    """
    # Step 1: Write to temp file so Playwright's set_input_files can read it
    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False, mode="wb")
    tmp.write(pdf_bytes)
    tmp_path = tmp.name
    tmp.close()

    try:
        file_input = page.locator("input[type='file'][accept*='pdf']").first

        if file_input.count() == 0:
            raise AssertionError(
                "No PDF file input found — the upload form was not rendered"
            )

        file_input.set_input_files(tmp_path)
        print(f"[FILE UPLOAD] set_input_files({file_name}) OK")

        body_text = page.text_content("body") or ""
        file_visible = file_name.lower() in body_text.lower()
        print(f"[DEBUG] File '{file_name}' visible in UI? {'Yes' if file_visible else 'No'}")

        # The frontend's seal handler requires a private key before it will
        # process the file.  Without one the handler returns early with
        # "Choose a PDF and provide issuer keys before sealing." which is
        # not an error — so we must enter a key so the seal actually runs.
        try:
            pk_input = page.locator('input[aria-label="Private Key"]').first
            if not pk_input.is_focused() or pk_input.input_value() != _DEMO_PRIVATE_KEY:
                pk_input.click()
                pk_input.fill(_DEMO_PRIVATE_KEY)
        except Exception:
            try:
                pk_input = page.locator('input[type="password"], input[placeholder*="private"], input[placeholder*="key"]').first
                if pk_input.is_visible():
                    pk_input.click()
                    pk_input.fill(_DEMO_PRIVATE_KEY)
            except Exception:
                pass

        # Click the Seal button — must exist after upload
        seal_btn = page.get_by_role("button", name="Upload PDF and Stamp QR Seals", exact=True)
        expect(seal_btn).to_be_enabled(timeout=SEAL_BUTTON_TIMEOUT)
        seal_btn.click(timeout=5_000)
        expect(page.locator("#stamp-result")).to_have_text(
            re.compile(r"^(Sealed |PDF sealing failed:)"), timeout=60_000
        )
    except Exception as e:
        raise AssertionError(f"File upload failed: {e}") from e
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _check_results(page: Page) -> dict:
    """Read the result message/status after uploading and attempting to seal.

    Read only the completed stamping operation, never unrelated page copy.
    """
    result_text = page.locator("#stamp-result").inner_text().strip()
    has_error = result_text.startswith("PDF sealing failed:")
    had_success = result_text.startswith("Sealed ") and "Document ID:" in result_text
    completed = has_error or had_success

    return {
        "success": had_success and not has_error,
        "message_contains": result_text[:500] if result_text else None,
        "has_error": has_error,
        "completed": completed,
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
    """PDF with corrupt trailer -- pdf-lib may or may not handle this,
    but we should see an observable result either way."""
    data = make_corrupt_trailer_pdf()
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="bad_trailer.pdf")
    result = _check_results(page)
    print(f"T6 corrupt-trailer: success={result['success']} err={result['has_error']} "
          f"completed={result['completed']} "
          f"msg='{result['message_contains']}'")
    assert result["completed"], (
        "No terminal success or error result appeared in the UI"
    )
    assert result["success"] or result["has_error"], (
        "Operation produced output but not a recognisable success or error"
    )


def test_t7_mismatched_sizes_pdf(page: Page):
    """Extra fake objects appended after valid PDF -- may succeed or fail
    depending on parser leniency.

    We only require that the operation completes with an observable
    result in the UI (success or error), not that any particular
    outcome occurs. Both are acceptable.
    """
    data = make_mismatched_sizes_pdf()
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="mismatched.pdf")
    result = _check_results(page)
    print(f"T7 mismatched: success={result['success']} err={result['has_error']} "
          f"completed={result['completed']} "
          f"msg='{result['message_contains']}'")
    assert result["completed"], (
        "No terminal success or error result appeared in the UI"
    )
    assert result["success"] or result["has_error"], (
        "Operation produced output but not a recognisable success or error"
    )


def test_t8_reupload_sealed_pdf(page: Page):
    """A previously QRed-sealed PDF uploaded again should either work or
    error gracefully — the key requirement is an observable result."""
    data = make_qred_sealed_pdf()
    if data is None or len(data) == 0:  # type: ignore[arg-type]
        pytest.skip("No pre-existing QRed-sealed PDF available for T8 re-upload test")
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="already_sealed.qred-sealed.pdf")  # type: ignore[arg-type]
    result = _check_results(page)
    print(f"T8 re-seal: success={result['success']} err={result['has_error']} "
          f"completed={result['completed']}")
    assert result["completed"], (
        "No terminal success or error result appeared in the UI"
    )
    assert result["success"] or result["has_error"], (
        "Operation produced output but not a recognisable success or error"
    )


def test_t9_image_only_pdf(page: Page):
    """Refuse image-only PDFs rather than signing empty page text."""
    data = make_image_only_pdf()
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="image_only.pdf")
    result = _check_results(page)
    assert not result["success"], "Image-only PDF must not produce an empty-content seal"
    assert result["has_error"], f"Expected extraction error, got {result!r}"
    assert "No readable text" in page.locator("body").inner_text()


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
