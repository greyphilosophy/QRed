"""Real, local-only selected-photo preparation with synthetic input pixels."""
import io
from pathlib import Path

from PIL import Image
from playwright.sync_api import expect

from browser_helpers import BASE_URL, OfflineNetworkGuard, show_file_inputs, wait_for_offline_resources


SUBMITTED_DIMENSIONS = """(() => {
    const OriginalWorker = window.Worker;
    window.__photoSubmissions = [];
    window.Worker = class extends OriginalWorker {
        postMessage(value, options) {
            if (value?.image && !value.prepareReading) {
                window.__photoSubmissions.push({width: value.image.width,
                    height: value.image.height, bytes: value.image.data.byteLength});
            }
            return super.postMessage(value, options);
        }
    };
})();"""


def test_homepage_large_selected_photo_is_bounded_before_real_worker(browser):
    """48 MP source reaches the real worker as 12 MP, with local diagnostics."""
    output = io.BytesIO()
    Image.new("RGB", (6000, 8000), "white").save(output, format="PNG")
    context = browser.new_context(service_workers="allow", viewport={"width": 430, "height": 932})
    try:
        guard = OfflineNetworkGuard(context)
        context.add_init_script(SUBMITTED_DIMENSIONS)
        page = context.new_page()
        page.goto(BASE_URL, wait_until="networkidle")
        wait_for_offline_resources(page, photo=True)
        guard.block()
        show_file_inputs(page)
        page.locator("#qr-image").set_input_files({"name": "synthetic-48mp.png", "mimeType": "image/png",
                                                   "buffer": output.getvalue()})
        page.wait_for_function("window.__photoSubmissions.length > 0")
        assert page.evaluate("window.__photoSubmissions") == [
            {"width": 3000, "height": 4000, "bytes": 48_000_000}]
        # Blank paper is not a recovery fixture. Either an early miss or the
        # 60-second watchdog can finish it. Both must retain size diagnostics.
        expect(page.get_by_text("Selected photo: 3000 × 4000", exact=False)).to_be_visible(timeout=75000)
        expect(page.get_by_text("from 6000 × 8000, prepared in", exact=False)).to_be_visible()
        expect(page.get_by_role("button", name="Cancel photo scan")).to_have_count(0)
        guard.assert_quiet()
    finally:
        context.close()


def test_homepage_small_ordinary_qr_remains_readable_offline(browser):
    """The general input must not inherit the 4 MP full-page capture floor."""
    context = browser.new_context(service_workers="allow")
    try:
        guard = OfflineNetworkGuard(context)
        context.add_init_script(SUBMITTED_DIMENSIONS)
        page = context.new_page()
        page.goto(BASE_URL, wait_until="networkidle")
        wait_for_offline_resources(page, photo=True)
        guard.block()
        show_file_inputs(page)
        page.locator("#qr-image").set_input_files(Path(__file__).with_name("qr_test_plain.png"))
        expect(page.get_by_text("Unverified QR content:", exact=False)).to_be_visible(timeout=15000)
        assert page.evaluate("window.__photoSubmissions") == [
            {"width": 290, "height": 290, "bytes": 290 * 290 * 4}]
        expect(page.get_by_role("heading", name="Seal authenticated", exact=True)).to_have_count(0)
        guard.assert_quiet()
    finally:
        context.close()
