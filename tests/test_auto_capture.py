"""Hands-free whole-page capture with native still photos, real QR decoding, and OCR."""
import base64
import io
import json
import os
import zipfile
import xml.etree.ElementTree as ET

import pytest
from PIL import Image
from playwright.sync_api import expect
from browser_helpers import (BASE_URL, NATIVE_PHOTO_CAMERA_SCRIPT, OfflineNetworkGuard,
                             assert_document_preview_not_decoded, observe_document_scan_requests,
                             wait_for_offline_resources)
from test_photo_verification import sealed_text, camera_paper, TEXT, PUBLIC_KEY, persistent_state, prepare_reader

CAPTURED_NOTICE = "Photo captured. You can move your phone."


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
def test_native_still_capture_keeps_more_detail_and_acknowledges_only_after_capture(browser, sealed_text, path):
    context = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="allow")
    page = context.new_page()
    try:
        context.route("**/api/keys/default", lambda route: route.fulfill(json={"public_key": PUBLIC_KEY}))
        page.goto(os.environ.get("QRED_BASE_URL", "http://localhost:3000") + path, wait_until="networkidle")
        if path != "/":
            page.locator("#publicKeyFileInput").set_input_files({"name": "key.txt", "mimeType": "text/plain", "buffer": PUBLIC_KEY.encode()})
        prepare_reader(page)
        camera_paper(page, TEXT.replace("Friday", "Monday"), sealed_text[1]["qr"])
        awaitable = """async () => {
            const still = document.createElement('canvas');
            still.width = __syntheticNativePhoto.naturalWidth; still.height = __syntheticNativePhoto.naturalHeight;
            still.getContext('2d').drawImage(__syntheticNativePhoto, 0, 0);
            const photo = await new Promise(resolve => still.toBlob(resolve, 'image/png'));
            const openBitmap = window.createImageBitmap.bind(window);
            window.createImageBitmap = async (source, ...options) => {
                if (source === photo) await new Promise(resolve => { window.finishOpeningPhoto = resolve; });
                return openBitmap(source, ...options);
            };
            const small = document.createElement('canvas'); small.width = 360; small.height = 480;
            small.getContext('2d').drawImage(__syntheticPaper, 0, 0, 360, 480);
            const preview = new Image(); preview.src = small.toDataURL(); await preview.decode();
            __syntheticCameraFrame.width = 360; __syntheticCameraFrame.height = 480;
            __syntheticPaper = preview;
            window.stillRequests = [];
            window.ImageCapture = class {
                async getPhotoCapabilities() { return {imageWidth:{min:640,max:2880},imageHeight:{min:853,max:3840}}; }
                async takePhoto(settings) {
                    stillRequests.push(settings);
                    await new Promise(resolve => { window.finishStillCapture = resolve; });
                    return photo;
                }
            };
        }"""
        # A low-resolution preview must still guide a high-detail native photo.
        # The former 420px minimum could never pass on a 360px-wide stream.
        page.evaluate(awaitable)
        observe_document_scan_requests(page)
        baseline = persistent_state(page)
        downloads = []; page.on("download", lambda item: downloads.append(item))
        page.get_by_role("button", name="Check document", exact=True).click()
        page.wait_for_function("stillRequests.length === 1")
        expect(page.get_by_text("Hold steady — taking photo…", exact=True)).to_be_visible()
        expect(page.get_by_text(CAPTURED_NOTICE, exact=True)).to_have_count(0)
        page.evaluate("finishStillCapture()")
        page.wait_for_function("typeof finishOpeningPhoto === 'function'")
        expect(page.get_by_text(CAPTURED_NOTICE, exact=True)).to_be_visible()
        assert assert_document_preview_not_decoded(page) == []
        page.evaluate("finishOpeningPhoto()")
        expect(page.locator(".page-check-list button")).to_have_count(1, timeout=15000)
        assert page.evaluate("stillRequests[0]") == {"fillLightMode": "off", "imageWidth": 2880, "imageHeight": 3840}
        expect(page.get_by_text("Move the page to capture again, or use Capture now.", exact=True)).to_be_visible(timeout=5000)
        # A still photo can take longer than the gate's normal frame-gap limit.
        # The stationary page must not start another exposure after that delay.
        page.wait_for_timeout(2000)
        assert page.evaluate("stillRequests.length") == 1
        if path == "/":
            # Capture, Choose photo, and Check this page must stay inside the
            # same two-row area instead of covering the stationary guide's advice.
            controls = page.locator(".ar-display-scanning .ar-controls").bounding_box()
            feedback = page.locator(".ar-display-scanning .ar-scan-feedback").bounding_box()
            assert controls and feedback
            assert feedback["y"] + feedback["height"] <= controls["y"]
        page.get_by_role("button", name="Check this page now", exact=True).click()
        review = page.get_by_role("region", name="Review Page 2 of 2", exact=True)
        expect(review.locator(".photo-differences")).to_contain_text("Monday", timeout=30000)
        # The review copy has the existing 6MP retention cap; the decoder below
        # must still receive the full-resolution native capture.
        assert review.locator(".photo-stage img").evaluate("img => [img.naturalWidth,img.naturalHeight]") == [2121, 2828]
        decoded = assert_document_preview_not_decoded(page)
        assert decoded and all(request["width"] == 2880 and request["height"] == 3840 for request in decoded)
        assert persistent_state(page) == baseline
        assert downloads == []
        page.get_by_role("button", name="Finish & clear", exact=True).click()
        assert page.evaluate("__cameraTracks.every(track => track.readyState === 'ended')")
    finally:
        context.close()


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
        expect(review.locator(".photo-summary")).to_have_text("Printed text: Recognized text matches the signed text", timeout=60000)
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
        page.evaluate("""message => {
            window.__moveOnCapture = true;
            window.__captureNotices = 0;
            // Both live previews start with an enabled torch. Record the
            // applied hardware settings at capture and through the retake.
            const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            window.__torchChanges = []; window.__torchAtNotice = [];
            navigator.mediaDevices.getUserMedia = async (...args) => {
                const stream = await open(...args), [track] = stream.getVideoTracks();
                const changes = []; __torchChanges.push(changes);
                let torch = true;
                track.getCapabilities = () => ({torch: true});
                track.getSettings = () => ({torch});
                track.applyConstraints = async request => {
                    const value = request.torch?.exact ?? request.advanced?.find(entry => 'torch' in entry)?.torch;
                    if (typeof value === 'boolean') { torch = value; changes.push(value); }
                };
                return stream;
            };
            new MutationObserver(() => {
                if (!window.__moveOnCapture) return;
                const statuses = document.querySelectorAll('.camera-capture-notice[role="status"]');
                if (![...statuses].some(node => node.textContent === message)) return;
                window.__moveOnCapture = false;
                __torchAtNotice.push(__cameraTracks.at(-1).getSettings().torch);
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
        }""", CAPTURED_NOTICE)
        page.get_by_role("button", name="Check document", exact=True).click()
        page.wait_for_function("window.__captureNotices === 1")
        assert page.evaluate("window.__noticeBeforeSeal")
        expect(page.locator(".page-check-list button")).to_have_count(1, timeout=15000)
        expect(page.get_by_role("button", name="Flashlight on", exact=True)).to_be_enabled()
        assert page.evaluate("__torchAtNotice") == [False]
        assert page.evaluate("__torchChanges") == [[False, True]]
        page.get_by_role("button", name="Check this page now", exact=True).click()
        review = page.get_by_role("region", name="Review Page 2 of 2", exact=True)
        expect(review.locator(".photo-differences")).to_contain_text("Monday", timeout=15000)
        # The same capture acknowledgement protects an automatic retake.
        camera_paper(page, TEXT, sealed_text[1]["qr"])
        page.evaluate("window.__moveOnCapture = true")
        review.get_by_role("button", name="Retake this page", exact=True).click()
        page.wait_for_function("window.__captureNotices === 2")
        expect(page.get_by_role("dialog")).to_have_count(0, timeout=15000)
        assert page.evaluate("__torchAtNotice") == [False, False]
        assert page.evaluate("__torchChanges") == [[False, True], [False]]
        expect(review.locator(".photo-summary")).to_have_text("Printed text: Recognized text matches the signed text", timeout=15000)
        page.screenshot(path=str(tmp_path / "captured-before-processing.png"), full_page=True)
        page.get_by_role("button", name="Finish & clear", exact=True).click()
        assert page.evaluate("window.__cameraTracks.every(track => track.readyState === 'ended')")
    finally:
        context.close()


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
@pytest.mark.parametrize("failure", ["unavailable", "rejected", "undersized"])
def test_document_capture_failure_never_decodes_video_and_can_retry(browser, sealed_text, path, failure):
    context = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="allow")
    try:
        context.route("**/api/keys/default", lambda route: route.fulfill(json={"public_key": PUBLIC_KEY}))
        page = context.new_page()
        page.goto(os.environ.get("QRED_BASE_URL", "http://localhost:3000") + path, wait_until="networkidle")
        if path != "/":
            page.locator("#publicKeyFileInput").set_input_files({"name": "key.txt", "mimeType": "text/plain", "buffer": PUBLIC_KEY.encode()})
        # The readable preview must not be accepted when a native photo fails.
        # No border keeps this case on the explicit manual-capture path.
        photo = camera_paper(page, TEXT, sealed_text[1]["qr"], border=False)
        observe_document_scan_requests(page)
        page.evaluate("""failure => {
            if (failure === 'unavailable') { window.ImageCapture = undefined; return; }
            window.ImageCapture = class {
                async getPhotoCapabilities() { return {imageWidth:{min:1,max:3000},imageHeight:{min:1,max:4000}}; }
                async takePhoto() {
                    if (failure === 'rejected') throw new DOMException('Synthetic camera failure', 'NotReadableError');
                    // Advertised capability is not evidence of the returned size.
                    const preview = window.__syntheticCameraFrame;
                    return new Promise(resolve => preview.toBlob(resolve, 'image/png'));
                }
            };
        }""", failure)
        page.get_by_role("button", name="Check document", exact=True).click()
        page.wait_for_function("__documentScanRequests.some(request => request.live)")
        page.get_by_role("button", name="Capture now", exact=True).click()
        expect(page.get_by_text("No video frame was scanned.", exact=False)).to_be_visible(timeout=10000)
        expect(page.locator(".page-check-list button")).to_have_count(0)
        assert assert_document_preview_not_decoded(page) == []
        expect(page.get_by_role("button", name="Choose photo", exact=True)).to_be_visible()
        assert page.locator("input[capture]").count() == 0
        if failure == "unavailable":
            # The compatibility path is an explicit local file choice.
            with page.expect_file_chooser() as selected:
                page.get_by_role("button", name="Choose photo", exact=True).click()
            selected.value.set_files(photo)
        else:
            page.evaluate(NATIVE_PHOTO_CAMERA_SCRIPT)
            page.get_by_role("button", name="Capture now", exact=True).click()
        expect(page.locator(".page-check-list button")).to_have_count(1, timeout=15000)
        decoded = assert_document_preview_not_decoded(page)
        assert len(decoded) == 1
        assert decoded[0]["width"] == 2400 and decoded[0]["height"] == 3200
    finally:
        context.close()

@pytest.mark.parametrize("path", ["/", "/verify.htm"])
def test_save_scan_photo_preserves_pixels_and_capture_metadata_offline(browser, path):
    context = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="allow")
    try:
        guard = OfflineNetworkGuard(context)
        page = context.new_page()
        page.goto(BASE_URL + path, wait_until="networkidle")
        prepare_reader(page)
        wait_for_offline_resources(page, photo=True)
        guard.block()
        camera_paper(page, "", None, border=False)
        # Only the decoder verdict is forced. Both screens use the production
        # still capture and ZIP download code.
        page.evaluate("""() => {
            window.shutterCount = 0;
            window.ImageCapture = class {
                async takePhoto() {
                    window.shutterCount++;
                    return window.shutterPhoto;
                }
            };
            window.Worker = class extends Worker {
                postMessage(message, options) {
                    if (!message.image || message.live || message.prepareReading) return super.postMessage(message, options);
                    const data = {action:{status:"feedback", timedOut:true, message:"Synthetic scan timed out."}};
                    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {data})));
                }
            };
        }""")
        page.get_by_role("button", name="Check document", exact=True).click()
        page.wait_for_function("document.querySelector('video')?.videoWidth > 0")
        save = page.get_by_role("button", name="Save scan photo", exact=True)
        downloads = []
        page.on("download", lambda download: downloads.append(download))
        for index, (fmt, extension) in enumerate([("jpeg", "jpg"), ("png", "png")]):
            stream = io.BytesIO()
            exif = Image.Exif()
            exif[270] = f"Synthetic scan {index}"
            Image.new("RGB", (1600, 2560), (70, index * 80, 128)).save(stream, fmt, exif=exif)
            original = stream.getvalue()
            page.evaluate("""file => { window.shutterPhoto = new Blob(
                [Uint8Array.from(atob(file.bytes), c => c.charCodeAt(0))], {type:file.type}); }""",
                          {"type": "image/" + fmt, "bytes": base64.b64encode(original).decode()})
            page.get_by_role("button", name="Capture now", exact=True).click()
            expect(save).to_be_visible()
            assert page.evaluate("shutterCount") == index + 1
            assert len(downloads) == index
            with page.expect_download() as download:
                save.click()
            assert download.value.suggested_filename == "QRed-scan-photo.zip"
            with zipfile.ZipFile(download.value.path()) as archive:
                name = f"exposure-01.{extension}"
                assert archive.namelist() == [name, "qred-scan.json"]
                saved = archive.read(name)
                manifest = json.loads(archive.read("qred-scan.json"))
                record = manifest["photos"][0]
                assert record["name"] == name
                metadata = record["metadata"]
                assert metadata["schema"] == "qred-scan-capture"
                assert metadata["capture"]["trigger"] == "manual"
                assert metadata["image"]["decodedSize"] == {"width": 1600, "height": 2560}
                assert metadata["processing"]["qredLensCorrection"] == "not-applied"
                assert metadata["calibration"] is None
                assert "deviceId" not in metadata["capture"]["trackSettings"]
                if fmt == "jpeg":
                    assert record["embeddedXmp"] is True
                    saved_image = Image.open(io.BytesIO(saved))
                    assert saved_image.tobytes() == Image.open(io.BytesIO(original)).tobytes()
                    assert saved_image.getexif()[270] == f"Synthetic scan {index}"
                    packet = next(data[29:] for marker, data in saved_image.applist
                                  if marker == "APP1" and data.startswith(b"http://ns.adobe.com/xap/1.0/\0"))
                    embedded = ET.fromstring(packet).find(".//{https://qred.org/ns/scan/1.0/}Capture")
                    assert json.loads(embedded.text) == metadata
                else:
                    assert record["embeddedXmp"] is False
                    assert saved == original
        guard.assert_quiet()
    finally:
        context.close()
