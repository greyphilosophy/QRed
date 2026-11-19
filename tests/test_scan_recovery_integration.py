"""Real pixel recovery, worker checkpoints, deadlines and verifier collection.

Only the first worker's continued execution and the browser clock are controlled.
No recovered payload, signature verdict or collection state is fabricated.
"""
import io
from pathlib import Path

import pytest
from PIL import Image
from playwright.sync_api import expect

from browser_helpers import (BASE_URL, OfflineNetworkGuard, prepare_text_for_offline,
                             show_file_inputs, show_seal_details, wait_for_offline_resources)


STOP_AFTER_CHECKPOINT = """(() => {
    const NativeWorker = window.Worker;
    window.__checkpointCount = 0;
    window.__checkpointStallAssigned = false;
    window.Worker = class extends NativeWorker {
        constructor(...args) {
            super(...args);
            this.addEventListener('message', event => {
                if (this.checkpointStalled) { event.stopImmediatePropagation(); return; }
                const progress = event.data.progress;
                if (this.stallAfterCheckpoint && progress?.texts?.length) {
                    window.__checkpointCount = progress.texts.length;
                    this.checkpointStalled = true;
                    // Forward this real checkpoint, then simulate a decoder
                    // that cannot finish. The production watchdog must act.
                    super.terminate();
                    if (window.__dropCheckpoint) event.stopImmediatePropagation();
                }
            });
        }
        postMessage(message, transfer) {
            if (message.image && !message.live && !message.prepareReading
                    && !window.__checkpointStallAssigned) {
                window.__checkpointStallAssigned = true;
                this.stallAfterCheckpoint = true;
            }
            return super.postMessage(message, transfer);
        }
    };
})();"""


def chunk_photo(number):
    """Existing synthetic PDF pixels, padded to the document-photo size floor."""
    source = Path(__file__).parent / "fixtures/compact-qr" / f"delivery-part-{number}-200dpi.png"
    photo = Image.new("RGB", (1800, 2560), "white")
    with Image.open(source) as code:
        photo.paste(code, (625, 1005))
    output = io.BytesIO()
    photo.save(output, "PNG")
    return {"name": f"synthetic-chunk-{number}.png", "mimeType": "image/png", "buffer": output.getvalue()}


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
@pytest.mark.parametrize("drop_checkpoint", [False, True], ids=["retain-checkpoint", "lost-checkpoint-control"])
def test_real_partial_survives_watchdog_and_joins_a_later_photo(browser, path, drop_checkpoint):
    context = browser.new_context(service_workers="allow", viewport={"width": 430, "height": 932})
    try:
        guard = OfflineNetworkGuard(context)
        context.add_init_script(f"window.__dropCheckpoint = {'true' if drop_checkpoint else 'false'}")
        context.add_init_script(STOP_AFTER_CHECKPOINT)
        page = context.new_page()
        page.clock.install()
        page.goto(BASE_URL + path, wait_until="networkidle")
        prepare_text_for_offline(page)
        wait_for_offline_resources(page, photo=True)
        guard.block()
        show_file_inputs(page)
        picker = page.locator("#qr-image" if path == "/" else "#pagePhotoInput")
        picker.set_input_files(chunk_photo(1))
        page.wait_for_function("window.__checkpointCount === 1", timeout=30000)
        # No final worker result exists. Advance the real client's 60s timer;
        # these simulated timings are not optical or device performance claims.
        page.clock.fast_forward(60000)
        progress = page.locator(".verification-card .collection-progress" if path == "/" else "#resultMeta .collection-progress")
        if drop_checkpoint:
            # Negative control: the next photo cannot manufacture the missing
            # piece or authenticate a page from an incomplete transport.
            expect(page.get_by_text("The photo scan reached its time limit.", exact=False)).to_be_visible()
            expect(progress).to_have_count(0)
            picker.set_input_files(chunk_photo(2))
            expect(progress).to_contain_text("1 of 2 QR seals collected", timeout=75000)
            show_seal_details(page)
            expect(page.get_by_role("heading", name="INCOMPLETE", exact=True)).to_be_visible()
            expect(page.get_by_role("heading", name="Seal authenticated", exact=True)).to_have_count(0)
            guard.assert_quiet()
            return
        expect(progress).to_contain_text("1 of 2 QR seals collected", timeout=15000)
        show_seal_details(page)
        expect(page.get_by_role("heading", name="INCOMPLETE", exact=True)).to_be_visible()
        expect(page.get_by_role("heading", name="Seal authenticated", exact=True)).to_have_count(0)
        key = page.get_by_label("Open issuer public key file", exact=True)
        key.set_input_files({"name": "public-test-key.txt", "mimeType": "text/plain",
                             "buffer": b"eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q="})

        # Only the complementary piece is in this second photo. Losing the
        # earlier checkpoint cannot be hidden by rescanning a complete page.
        picker.set_input_files(chunk_photo(2))
        show_seal_details(page)
        expect(page.get_by_role("heading", name="Seal authenticated", exact=True)).to_be_visible(timeout=75000)
        expect(page.locator(".verification-result pre")).to_contain_text("Item 45: Received and inspected")
        expect(page.get_by_role("heading", name="INCOMPLETE", exact=True)).to_have_count(0)
        key.set_input_files({"name": "wrong-test-key.txt", "mimeType": "text/plain",
                             "buffer": b"Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI="})
        show_seal_details(page)
        expect(page.get_by_role("heading", name="INVALID", exact=True)).to_be_visible()

        page.get_by_role("button", name="Finish & clear", exact=True).click()
        show_file_inputs(page)
        picker.set_input_files(chunk_photo(2))
        expect(progress).to_contain_text("1 of 2 QR seals collected", timeout=75000)
        show_seal_details(page)
        expect(page.get_by_role("heading", name="INCOMPLETE", exact=True)).to_be_visible()
        expect(page.get_by_role("heading", name="Seal authenticated", exact=True)).to_have_count(0)
        guard.assert_quiet()
    finally:
        context.close()
