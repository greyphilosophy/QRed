"""Real pixel recovery, worker checkpoints, deadlines and verifier collection.

Camera input, worker continuation and the browser clock are controlled.
No recovered payload, signature verdict, OCR reading or collection state is fabricated.
"""
import base64
import io
import json
import re
import zipfile
from pathlib import Path

import pytest
from PIL import Image
from playwright.sync_api import expect

from browser_helpers import (BASE_URL, OfflineNetworkGuard, prepare_text_for_offline,
                             show_file_inputs, show_seal_details, wait_for_offline_resources)
from test_photo_verification import camera_paper, PUBLIC_KEY, prepare_reader, dated_form_photos, review_differences


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


def expect_incomplete(page, progress):
    expect(progress).to_contain_text("1 of 2 QR seals collected", timeout=75000)
    expect(page.get_by_text("This page needs more seal pieces. Keep scanning.", exact=True)).to_be_visible()
    expect(page.get_by_text("Seal authenticated", exact=True)).to_have_count(0)


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
        progress = page.locator(".verification-card .collection-progress" if path == "/" else "#statusText")
        if drop_checkpoint:
            # Negative control: the next photo cannot manufacture the missing
            # piece or authenticate a page from an incomplete transport.
            expect(page.get_by_text("The photo scan reached its time limit.", exact=False)).to_be_visible()
            expect(page.locator(".verification-card .collection-progress, #sealList .seal-item")).to_have_count(0)
            picker.set_input_files(chunk_photo(2))
            expect_incomplete(page, progress)
            guard.assert_quiet()
            return
        expect_incomplete(page, progress)
        key = page.get_by_label("Open issuer public key file", exact=True)
        key.set_input_files({"name": "public-test-key.txt", "mimeType": "text/plain",
                             "buffer": b"eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q="})

        # Only the complementary piece is in this second photo. Losing the
        # earlier checkpoint cannot be hidden by rescanning a complete page.
        picker.set_input_files(chunk_photo(2))
        show_seal_details(page)
        verdict = page.locator(".verification-result > h3" if path == "/" else "#resultStatus")
        content = page.locator(".verification-result pre" if path == "/" else "#resultContent")
        expect(verdict).to_have_text("Seal authenticated", timeout=75000)
        expect(content).to_contain_text("Item 45: Received and inspected")
        expect(page.get_by_role("heading", name="INCOMPLETE", exact=True)).to_have_count(0)
        key.set_input_files({"name": "wrong-test-key.txt", "mimeType": "text/plain",
                             "buffer": b"Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI="})
        show_seal_details(page)
        expect(verdict).to_have_text("INVALID")

        page.get_by_role("button", name="Finish & clear", exact=True).click()
        show_file_inputs(page)
        picker.set_input_files(chunk_photo(2))
        expect_incomplete(page, progress)
        guard.assert_quiet()
    finally:
        context.close()


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
def test_saved_rotated_native_photo_reopens_with_its_digit_difference(browser, dated_form_photos, path, tmp_path):
    """Capture -> metadata/XMP ZIP -> fresh page -> real seal and OCR comparison."""
    stream = io.BytesIO()
    with Image.open(io.BytesIO(dated_form_photos["changed"]["buffer"])) as source:
        rotated = source.transpose(Image.Transpose.ROTATE_90)
        exif = Image.Exif()
        exif[274] = 6  # Browser rotation restores the original portrait page.
        rotated.save(stream, "JPEG", quality=95, subsampling=0, exif=exif)
    context = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="allow")
    try:
        guard = OfflineNetworkGuard(context)
        context.route("**/api/keys/default", lambda route: route.fulfill(json={"public_key": PUBLIC_KEY}))
        page = context.new_page()
        page.clock.install()
        page.goto(BASE_URL + path, wait_until="networkidle")
        # The first navigation precedes service-worker installation. Load the
        # public app once under its installed worker before testing an offline
        # reload; OCR preparation alone only promises the current tab works.
        wait_for_offline_resources(page, photo=True)
        page.reload(wait_until="networkidle")
        prepare_reader(page)
        wait_for_offline_resources(page, photo=True)
        page.wait_for_function("async () => Boolean(await caches.match(location.href))")
        guard.block()
        camera_paper(page, "", None, border=False)
        page.evaluate("""bytes => {
            window.__savedScanStalled = false;
            window.__savedScanShutters = 0;
            const photo = new Blob([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], {type:'image/jpeg'});
            window.ImageCapture = class {
                async takePhoto() { window.__savedScanShutters++; return photo; }
            };
            window.Worker = class extends Worker {
                postMessage(message, transfer) {
                    if (message.image && !message.live && !message.prepareReading
                            && !window.__savedScanStalled) {
                        // Model a worker that never answers. Keep native capture,
                        // the watchdog, archive writing and later decoding real.
                        window.__savedScanStalled = true;
                        return;
                    }
                    return super.postMessage(message, transfer);
                }
            };
        }""", base64.b64encode(stream.getvalue()).decode())
        page.get_by_role("button", name="Check document", exact=True).click()
        page.wait_for_function("document.querySelector('video')?.videoWidth > 0")
        page.get_by_role("button", name="Capture now", exact=True).click()
        page.wait_for_function("window.__savedScanStalled")
        page.clock.fast_forward(60000)
        with page.expect_download() as download:
            page.get_by_role("button", name="Save scan photo", exact=True).click()
        saved_path = tmp_path / download.value.suggested_filename
        download.value.save_as(saved_path)
        assert page.evaluate("window.__savedScanShutters") == 1
        with zipfile.ZipFile(saved_path) as archive:
            record = json.loads(archive.read("qred-scan.json"))["photos"][0]
            assert record["embeddedXmp"] is True
            assert record["metadata"]["image"]["decodedSize"] == {"width": 1920, "height": 2560}
            assert Image.open(io.BytesIO(archive.read(record["name"]))).getexif()[274] == 6

        # A fresh offline page has none of the capture's in-memory objects or
        # worker instrumentation. Its only document input is the downloaded ZIP.
        # Permit public app startup requests in the guard; the browser remains
        # offline, so navigation must use the installed worker's cached shell.
        guard.preparing = True
        page.reload(wait_until="networkidle")
        prepare_reader(page)
        guard.block()
        if path != "/":
            page.locator("#publicKeyFileInput").set_input_files({
                "name": "issuer.txt", "mimeType": "text/plain", "buffer": PUBLIC_KEY.encode()})
        with page.expect_file_chooser() as picked:
            page.get_by_role("button", name="Browse files", exact=True).click()
        picked.value.set_files(saved_path)
        review = page.get_by_role("region", name="Review Page 1 of 1", exact=True)
        expect(review.get_by_role("heading", name=re.compile("Seal: authenticated"))).to_be_visible(timeout=30000)
        expect(page.locator(".page-check-status.queued, .page-check-status.reading")).to_have_count(0, timeout=60000)
        assert review.locator(".photo-stage img").evaluate("img => [img.naturalWidth, img.naturalHeight]") == [1920, 2560]
        cards = review_differences(review)
        assert any("03-14-27" in card for card in cards)
        assert sum(bool(re.search(r"Photo reading: [^\n]*\b03-14-29\b", card)) for card in cards) == 1
        expect(review.locator(".photo-summary")).to_contain_text("to review")
        guard.assert_quiet()
    finally:
        context.close()
