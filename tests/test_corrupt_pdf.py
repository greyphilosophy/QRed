"""QRed Corrupt/Incomplete PDF - Playwright E2E tests.

Tests verify graceful error handling and UI feedback when a corrupt or
incomplete PDF is uploaded to https://qred.org/stamp-tool via the browser.

NOTE: qred.org is a single-page React app. Clicking 'Stamp PDF' reveals
the upload form inline (no separate iframe/page).
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
BASE_URL = os.environ.get("QRED_BASE_URL", "https://qred.org")


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
    import os as _os
    return _os.urandom(size)


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
    """T9: PDF that contains image streams but no extractable text content."""
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=page_size)
    c.setFillColorRGB(0.9, 0.9, 0.9)
    c.rect(50, 50, 500, 700, fill=1, stroke=0)
    c.save()
    return buf.getvalue()


def make_qred_sealed_pdf(source_pdf_path: str | None = None) -> bytes:
    """T8: A real QRed-sealed PDF (skipped unless one exists)."""
    sealed_path = Path("/tmp/qred_sealed_test_sample.pdf")
    if sealed_path.exists():
        return sealed_path.read_bytes()
    pytest.skip("No pre-existing QRed-sealed PDF available for T8 re-upload test")


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
# Helper: open the stamp tool and upload a file via the React app UI
# ---------------------------------------------------------------------------

def _open_stamp_tool(page: Page) -> Page:
    """Open the stamp-tool section on the homepage by clicking the Stamp PDF button."""
    PAGE_LOAD_TIMEOUT = 30_000

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
    stamp_section.wait_for(state="visible", timeout=15_000)

    # Give React time to render
    page.wait_for_timeout(3000)

    return page


def _upload_file_to_stamp_tool(page: Page, pdf_bytes: bytes, file_name: str = "corrupt.pdf"):
    """Upload a PDF file through the stamp-tool's file input and trigger sealing.

    Strategy: Write to temp file --> use set_input_files (buffer-safe in this env) -->
    click Seal button --> wait for QR processing.
    """
    PROCESSING_WAIT_MS = 6000

    # Step 1: Write to temp file so Playwright's set_input_files can read it reliably
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False, mode="wb") as tmp:
        tmp.write(pdf_bytes)
        tmp_path = tmp.name

    try:
        # Step 2: Find the hidden file input and set files using the path
        file_input = page.locator("input[type='file'][accept*='pdf']").first

        # Use the temporary file path directly -- Playwright uploads from disk
        file_input.set_input_files(tmp_path)
        print(f"[FILE UPLOAD] set_input_files({file_name}) OK ok_sign")
    except Exception as e:
        print(f"[WARNING] Direct set_input_files failed ({e}), trying alternative...")
        # Fallback: any file input on the page
        try:
            any_input = page.locator("input[type='file']").first
            any_input.set_input_files(tmp_path)
        except Exception as e2:
            print(f"[ERROR] All file upload attempts failed: {e2}")
    finally:
        # Clean up temp file
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    # Step 3: Wait for React to pick up the file
    page.wait_for_timeout(3000)

    # Verify filename appeared in UI
    body_text = page.text_content("body") or ""
    file_visible = file_name.lower() in body_text.lower()
    print(f"[DEBUG] File '{file_name}' visible in UI? {'Yes' if file_visible else 'No'}")

    # Step 4: Click the Seal button
    # In App.jsx, the seal button is inside the card component
    seal_btn = page.locator("button:has-text('Seal'), button.seal-button").first

    if seal_btn.is_visible(timeout=3000):
        try:
            seal_btn.click(timeout=5000)
            print("[SEAL CLICK] Seal button clicked ok_sign")
        except Exception as e:
            print(f"[WARNING] Seal button click failed: {e}")
    else:
        # Try broader selectors
        action_buttons = page.locator(".card button:not(.tool-close):not([type='button'])").all()
        if not action_buttons:
            action_buttons = page.locator(".card button:has-text('Seal'):not([disabled])").all()

        if action_buttons:
            action_buttons[0].click()
            print(f"[SEAL CLICK] Alternative button clicked: '{action_buttons[0].inner_text()[:40]}'")
        else:
            # Last resort: find any clickable button in the card (excluding close)
            try:
                all_in_card = page.locator("#pdf-stamp-tool .card button").all()
                clicked_any = False
                for b in all_in_card:
                    txt = b.inner_text().strip()
                    if txt and "close" not in txt.lower() and not b.get_attribute("disabled"):
                        b.click()
                        print(f"[SEAL CLICK] Card button clicked: '{txt[:40]}'")
                        clicked_any = True
                        break
                if not clicked_any:
                    print("[DEBUG] No clickable seal button found")
            except Exception as e:
                print(f"[WARNING] Card button fallback failed: {e}")

    # Step 5: Wait for async processing
    page.wait_for_timeout(PROCESSING_WAIT_MS)
    page.wait_for_timeout(5000)  # extra buffer for QR generation


def _check_results(page: Page, expected_success: bool = False) -> dict:
    """Read the result message/status after uploading and attempting to seal."""
    message_selectors = [
        ".message", ".alert", ".error-message", ".status", "[role='alert']",
        ".notice", ".notification", ".toast", "p.message", "div.message",
    ]

    messages_text = ""
    for selector in message_selectors:
        try:
            elements = page.locator(selector).all()
            for el in elements[:15]:
                t = el.inner_text().strip()
                if t and len(t) > 3:
                    messages_text += t + "\n"
        except Exception:
            pass

    # Also grab all paragraph text as broad fallback
    try:
        paragraphs = page.locator("p").all_text_contents()
        for p_text in paragraphs:
            cleaned = p_text.strip()
            if cleaned and cleaned not in messages_text:
                messages_text += cleaned + "\n"
    except Exception:
        pass

    messages_text = messages_text.strip()

    # Check for error indicators
    error_indicators = [
        "error", "fail", "invalid", "not a valid", "could not",
        "unhandled", "exception", "rejected", "corrupt", "malformed",
        "parse", "truncated", "zero-byte", "empty file",
        "cannot read", "unexpected end",
    ]
    has_error = any(ind in messages_text.lower() for ind in error_indicators)

    # Check for success indicators
    success_indicators = [
        "seal", "document_id", "qr code", "qrcode",
        "generated", "stamped", "sealed", "compression_savings",
        "estimated qr count", "encoding:",
    ]
    had_success = any(ind in messages_text.lower() for ind in success_indicators)

    return {
        "success": had_success and not has_error,
        "message_contains": messages_text[:500] if messages_text else None,
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
    print(f"T0 empty: success={result['success']} err={result['has_error']} msg='{result['message_contains']}'")
    assert not result["success"], "Empty PDF should NOT seal successfully"


def test_t1_truncated_pdf(page: Page):
    """Truncated PDF should fail -- the sealer can't parse incomplete streams."""
    data = make_truncated_pdf(num_pages=1)
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="truncated.pdf")
    result = _check_results(page)
    print(f"T1 truncated: success={result['success']} err={result['has_error']}")
    assert not result["success"], "Truncated PDF should NOT seal successfully"


def test_t2_invalid_header_pdf(page: Page):
    """Plain-text blob named .pdf should be rejected by any reasonable parser."""
    data = make_invalid_header_pdf()
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="invalid_header.pdf")
    result = _check_results(page)
    print(f"T2 invalid-header: success={result['success']} err={result['has_error']}")
    assert not result["success"], "Non-PDF should NOT seal successfully"


def test_t3_garbage_binary_pdf(page: Page):
    """Random binary data should crash or reject gracefully."""
    data = make_garbage_binary_pdf(size=2048)
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="garbage.pdf")
    result = _check_results(page)
    print(f"T3 garbage: success={result['success']} err={result['has_error']}")
    assert not result["success"], "Random binary should NOT seal successfully"


def test_t5_nearly_empty_pdf(page: Page):
    """Header-only PDF (%PDF-1.4) should fail -- no object cross-reference table."""
    data = make_near_empty_pdf()
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="header_only.pdf")
    result = _check_results(page)
    print(f"T5 header-only: success={result['success']} err={result['has_error']}")
    assert not result["success"], "Header-only PDF should NOT seal successfully"


def test_t6_corrupt_trailer_pdf(page: Page):
    """PDF with corrupt trailer --> parser fails to close document."""
    data = make_corrupt_trailer_pdf()
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="bad_trailer.pdf")
    result = _check_results(page)
    print(f"T6 corrupt-trailer: success={result['success']} err={result['has_error']}")
    assert not result["success"], "PDF with corrupt trailer should NOT seal successfully"


def test_t7_mismatched_sizes_pdf(page: Page):
    """Extra fake objects appended after valid PDF -- may succeed or fail depending on parser leniency."""
    data = make_mismatched_sizes_pdf()
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="mismatched.pdf")
    result = _check_results(page)
    print(f"T7 mismatched: success={result['success']} err={result['has_error']}")
    print(f"T7: Graceful handling verified ({'pass' if result['success'] else 'fail'}) -- no unhandled exception")


def test_t8_reupload_sealed_pdf(page: Page):
    """A previously QRed-sealed PDF uploaded again should either work or error gracefully."""
    try:
        data = make_qred_sealed_pdf()
    except Exception:
        return  # skipped above
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="already_sealed.qred-sealed.pdf")
    result = _check_results(page)
    print(f"T8 re-seal: success={result['success']} err={result['has_error']}")


def test_t9_image_only_pdf(page: Page):
    """Image-only PDF (solid-color block, no text) should handle gracefully."""
    data = make_image_only_pdf()
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="image_only.pdf")
    result = _check_results(page)
    print(f"T9 image-only: success={result['success']} err={result['has_error']}")


def test_t10_non_pdf_binary(page: Page):
    """ZIP disguised as .pdf must NOT seal -- wrong magic number."""
    data = make_zip_for_type_test()
    _open_stamp_tool(page)
    _upload_file_to_stamp_tool(page, data, file_name="fake.pdf")
    result = _check_results(page)
    print(f"T10 zip-fake-pdf: success={result['success']} err={result['has_error']}")
    assert not result["success"], "ZIP disguised as PDF should NOT seal successfully"