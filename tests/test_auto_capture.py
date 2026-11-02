"""Hands-free whole-page capture with real camera frames, QR decoding, and OCR."""
import os
import pytest
from playwright.sync_api import expect
from test_photo_verification import sealed_text, camera_paper, TEXT, PUBLIC_KEY, persistent_state, prepare_reader


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
def test_auto_capture_quality_manual_fallback_and_retake(browser, sealed_text, path, tmp_path):
    context = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="allow")
    page = context.new_page()
    try:
        context.route("**/api/keys/default", lambda route: route.fulfill(json={"public_key": PUBLIC_KEY}))
        page.goto(os.environ.get("QRED_BASE_URL", "http://localhost:3000") + path, wait_until="networkidle")
        if path != "/":
            page.locator("#publicKeyFileInput").set_input_files({"name": "key.txt", "mimeType": "text/plain", "buffer": PUBLIC_KEY.encode()})
        downloads = []
        page.on("download", lambda value: downloads.append(value))
        # A readable seal with no visible paper boundary must not capture itself.
        camera_paper(page, TEXT.replace("Friday", "Monday"), sealed_text[1]["qr"], border=False)
        page.get_by_role("button", name="Check document", exact=True).click()
        expect(page.get_by_text("Show all four page corners. Try a contrasting background, or use Capture now.", exact=True)).to_be_visible(timeout=45000)
        baseline = persistent_state(page)
        expect(page.locator(".page-check-list button")).to_have_count(0)
        expect(page.get_by_role("button", name="Check this page now", exact=True)).to_have_count(0)
        # Frame quality can be overridden; seal authentication cannot.
        page.get_by_role("button", name="Capture now", exact=True).click()
        expect(page.locator(".page-check-list button")).to_have_count(1, timeout=45000)
        page.get_by_role("button", name="Check this page now", exact=True).click()
        review = page.get_by_role("region", name="Review Page 2 of 2", exact=True)
        expect(review.locator(".photo-differences")).to_contain_text("Monday", timeout=60000)
        # Retakes wait for focus, then capture with no shutter tap.
        camera_paper(page, TEXT, sealed_text[1]["qr"], blur=6)
        review.get_by_role("button", name="Retake this page", exact=True).click()
        dialog = page.get_by_role("dialog")
        expect(dialog.get_by_text("The page edges look soft.", exact=False)).to_be_visible(timeout=30000)
        expect(dialog).to_be_visible()
        expect(review.locator(".photo-differences")).to_contain_text("Monday")
        page.screenshot(path=str(tmp_path / "waiting-for-focus.png"))
        # An automatic capture of another page still cannot replace this one.
        camera_paper(page, TEXT, sealed_text[0]["qr"])
        expect(dialog.get_by_role("alert")).to_contain_text("does not match Page 2", timeout=45000)
        camera_paper(page, TEXT, sealed_text[1]["qr"])
        expect(dialog).to_have_count(0, timeout=45000)
        expect(review.locator(".photo-summary")).to_have_text("Recognized text matches the signed text", timeout=60000)
        # A sharp photo of missing/unreadable print is still captured and reported.
        camera_paper(page, "", sealed_text[1]["qr"])
        review.get_by_role("button", name="Retake this page", exact=True).click()
        expect(page.get_by_role("dialog")).to_have_count(0, timeout=45000)
        expect(review.locator(".photo-summary")).to_contain_text("No text could be read", timeout=60000)
        assert persistent_state(page) == baseline
        page.get_by_role("button", name="Finish & clear", exact=True).click()
        expect(page.locator(".photo-stage img")).to_have_count(0)
        assert page.evaluate("window.__cameraTracks.every(track => track.readyState === 'ended')")
        assert downloads == []
    finally:
        context.close()


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
def test_capture_notice_keeps_the_photo_when_the_camera_moves(browser, sealed_text, path, tmp_path):
    context = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="allow")
    page = context.new_page()
    try:
        context.route("**/api/keys/default", lambda route: route.fulfill(json={"public_key": PUBLIC_KEY}))
        page.goto(os.environ.get("QRED_BASE_URL", "http://localhost:3000") + path, wait_until="networkidle")
        if path != "/":
            page.locator("#publicKeyFileInput").set_input_files({"name": "key.txt", "mimeType": "text/plain", "buffer": PUBLIC_KEY.encode()})
        prepare_reader(page)
        camera_paper(page, TEXT.replace("Friday", "Monday"), sealed_text[1]["qr"])
        page.evaluate("""() => {
            window.__moveOnCapture = true;
            window.__captureNotices = 0;
            new MutationObserver(() => {
                if (!window.__moveOnCapture) return;
                const statuses = document.querySelectorAll('.ar-scan-feedback, #pageGuideHint, .page-camera [role="status"]');
                if (![...statuses].some(node => node.textContent === 'Photo captured — processing…')) return;
                window.__moveOnCapture = false;
                if (!window.__captureNotices) window.__noticeBeforeSeal = !document.querySelector('.page-check-list button');
                window.__captureNotices++;
                // Move the paper completely out of view as soon as capture is
                // acknowledged, while the real seal worker is still running.
                const frame = window.__syntheticCameraFrame;
                const blank = document.createElement('canvas');
                blank.width = frame.width; blank.height = frame.height;
                const context = blank.getContext('2d');
                context.fillStyle = '#373737'; context.fillRect(0, 0, blank.width, blank.height);
                window.__syntheticPaper = blank;
                frame.getContext('2d').drawImage(blank, 0, 0);
            }).observe(document.body, {subtree: true, childList: true, characterData: true});
        }""")
        page.get_by_role("button", name="Check document", exact=True).click()
        page.wait_for_function("window.__captureNotices === 1")
        assert page.evaluate("window.__noticeBeforeSeal")
        expect(page.locator(".page-check-list button")).to_have_count(1, timeout=15000)
        page.get_by_role("button", name="Check this page now", exact=True).click()
        review = page.get_by_role("region", name="Review Page 2 of 2", exact=True)
        expect(review.locator(".photo-differences")).to_contain_text("Monday", timeout=15000)
        # The same capture acknowledgement protects an automatic retake.
        camera_paper(page, TEXT, sealed_text[1]["qr"])
        page.evaluate("window.__moveOnCapture = true")
        review.get_by_role("button", name="Retake this page", exact=True).click()
        page.wait_for_function("window.__captureNotices === 2")
        expect(page.get_by_role("dialog")).to_have_count(0, timeout=15000)
        expect(review.locator(".photo-summary")).to_have_text("Recognized text matches the signed text", timeout=15000)
        page.screenshot(path=str(tmp_path / "captured-before-processing.png"), full_page=True)
        page.get_by_role("button", name="Finish & clear", exact=True).click()
        assert page.evaluate("window.__cameraTracks.every(track => track.readyState === 'ended')")
    finally:
        context.close()
