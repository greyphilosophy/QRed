"""Camera workflow acceptance, not saved-photo decoder acceptance.

Only the hardware boundary is simulated. The PDF stamper, framing/steady gate,
native-still handoff, decoder, signature verification, and OCR are production
code. All document pixels are synthetic; no private phone photos are fixtures.
"""
import base64
import io
import json
import os
import subprocess
import time

import pytest
from PIL import Image, ImageEnhance, ImageFilter, ImageOps
from playwright.sync_api import expect
from reportlab.pdfgen import canvas

from browser_helpers import (
    NATIVE_PHOTO_CAMERA_SCRIPT, assert_document_preview_not_decoded,
    observe_document_scan_requests, prepare_text_for_offline, stamp_and_save,
)
from test_visual_page_seals import PRIVATE_KEY, PUBLIC_KEY

LINES = [
    "Scanner workflow invoice 1042", "Account 123456", "Approved total 123.45",
    "Payment due Friday", "Room 100.50", "Breakfast 12.00", "Parking 5.00",
    "Reference confirmed", "Keep this page for your records",
]


@pytest.fixture(scope="module")
def printed_workflow_page(browser, tmp_path_factory):
    """Use a freshly stamped, full-size production PDF, not an enlarged QR."""
    output = tmp_path_factory.mktemp("scanner-workflow")
    source = io.BytesIO()
    pdf = canvas.Canvas(source, pagesize=(612, 792))
    pdf.setFont("Helvetica", 14)
    pdf.drawString(72, 700, LINES[0])
    pdf.setFont("Helvetica", 12)
    for index, line in enumerate(LINES[1:]):
        pdf.drawString(72, 660 - index * 36, line)
    pdf.showPage()
    pdf.save()
    context = browser.new_context(service_workers="allow")
    try:
        page = context.new_page()
        page.goto(os.environ.get("QRED_BASE_URL", "http://localhost:3000"), wait_until="networkidle")
        page.get_by_role("button", name="Open PDF stamping tool").click()
        page.get_by_role("button", name="Private key (offline)", exact=True).click()
        page.get_by_label("Private Key", exact=True).fill(PRIVATE_KEY)
        stamped, result = stamp_and_save(page, {
            "name": "synthetic-workflow.pdf", "mimeType": "application/pdf", "buffer": source.getvalue(),
        }, output / "stamped.pdf")
        assert result["total_seals"] == 1
        expect(page.locator("#stamp-result")).not_to_contain_text("Clear footer added")
    finally:
        context.close()
    subprocess.run(["pdftoppm", "-singlefile", "-png", "-r", "240", str(stamped),
                    str(output / "printed")], check=True, capture_output=True)
    with Image.open(output / "printed.png") as image:
        assert image.size == (2040, 2640), "The test must use the whole original Letter page"
        return image.convert("RGB")


def camera_frames(printed, *, degraded=False, preview_size=(768, 960)):
    """Independent full-detail still plus lower-resolution changing previews.

    The mild print-scale/lighting/JPEG variation is deliberately fixed. It is
    one regression example, not a representative model of every phone camera.
    """
    paper = printed.copy()
    if degraded:
        smaller = paper.resize((1979, 2561), Image.Resampling.LANCZOS)
        paper = Image.new("RGB", printed.size, "white")
        paper.paste(smaller, (31, 40))  # 97% printer scale, physical page unchanged.
        paper = ImageEnhance.Brightness(paper).enhance(.86)
    still = Image.new("RGB", (2400, 3000), (55, 55, 55))
    still.paste(paper, (180, 180))
    if degraded:
        encoded = io.BytesIO()
        still.save(encoded, format="JPEG", quality=92)
        still = Image.open(io.BytesIO(encoded.getvalue())).convert("RGB")
    # Preview aspect/resolution can differ from the still. Letterbox without
    # stretching or increasing the original printed evidence resolution.
    preview = Image.new("RGB", preview_size, (55, 55, 55))
    scaled = ImageOps.contain(still, preview_size, Image.Resampling.LANCZOS)
    preview.paste(scaled, ((preview.width - scaled.width) // 2, (preview.height - scaled.height) // 2))
    frames = {
        "native": still,
        "clear": preview,
        "soft": preview.filter(ImageFilter.GaussianBlur(5)),
        "clipped": paper.resize(preview_size, Image.Resampling.LANCZOS),
    }
    if degraded:
        # Blur the middle of the sheet while its four edges remain sharp.
        soft_print = preview.copy()
        box = (preview.width // 8, preview.height // 8, preview.width * 7 // 8, preview.height * 7 // 8)
        soft_print.paste(preview.crop(box).filter(ImageFilter.GaussianBlur(1.8)), box)
        frames["soft-print"] = soft_print
    urls = {}
    for name, image in frames.items():
        encoded = io.BytesIO()
        image.save(encoded, format="PNG")
        urls[name] = "data:image/png;base64," + base64.b64encode(encoded.getvalue()).decode()
    return urls


def install_changing_camera(page, frames):
    page.evaluate("""async urls => {
        const images = {};
        for (const [name, url] of Object.entries(urls)) {
            const image = new Image(); image.src = url; await image.decode(); images[name] = image;
        }
        const frame = document.createElement('canvas');
        frame.width = images.clear.naturalWidth; frame.height = images.clear.naturalHeight;
        const context = frame.getContext('2d');
        window.__workflowCamera = {mode: 'clipped', opens: 0, tracks: [], ticks: 0, captures: []};
        window.__syntheticNativePhoto = images.native;
        let track;
        const draw = () => {
            const mode = __workflowCamera.mode;
            const at = performance.now() / 250;
            let x = 0, y = 0;
            if (mode === 'moving') {
                x = 35 / 768 * Math.sin(at); y = 25 / 960 * Math.cos(at);
            } else if (mode === 'handheld') {
                // Change pose after each real guidance sample. Waiting for
                // the animation to pause cannot supply a steady sequence.
                const n = __documentScanRequests.filter(r => r.live).length;
                x = n % 2 ? .009 : -.009; y = n % 2 ? .002 : -.002;
            }
            context.fillStyle = '#373737'; context.fillRect(0, 0, frame.width, frame.height);
            context.drawImage(images[['moving', 'handheld', 'frozen'].includes(mode) ? 'clear' : mode],
                Math.round(frame.width * x), Math.round(frame.height * y));
            track?.requestFrame();
        };
        window.__showWorkflowFrame = mode => {
            __workflowCamera.mode = mode;
            if (mode === 'guide') {
                // Place the whole printed page exactly where the visible corners
                // ask the user to hold it, accounting for object-fit: contain.
                const video = document.querySelector('video');
                const view = video.getBoundingClientRect();
                const box = document.querySelector('.page-scan-guide').getBoundingClientRect();
                const scale = Math.min(view.width / frame.width, view.height / frame.height);
                const left = view.left + (view.width - frame.width * scale) / 2;
                const top = view.top + (view.height - frame.height * scale) / 2;
                const guided = document.createElement('canvas');
                guided.width = frame.width; guided.height = frame.height;
                const g = guided.getContext('2d');
                g.fillStyle = '#373737'; g.fillRect(0, 0, guided.width, guided.height);
                g.drawImage(images.clipped, (box.left - left) / scale, (box.top - top) / scale,
                    box.width / scale, box.height / scale);
                images.guide = guided;
            }
            if (['clear', 'handheld', 'guide'].includes(mode)) __workflowCamera.clearAt = performance.now();
            draw();
        };
        __showWorkflowFrame('clipped');
        const timer = setInterval(() => {
            __workflowCamera.ticks++;
            if (__workflowCamera.mode !== 'frozen') draw();
        }, 100);
        navigator.mediaDevices.getUserMedia = async () => {
            __workflowCamera.opens++;
            const stream = frame.captureStream(0);
            [track] = stream.getVideoTracks();
            __workflowCamera.tracks.push(...stream.getTracks());
            draw();
            return stream;
        };
        navigator.mediaDevices.enumerateDevices = async () => [];
        window.addEventListener('pagehide', () => clearInterval(timer), {once:true});
        window.__workflowLongTasks = [];
        new PerformanceObserver(list => {
            for (const task of list.getEntries()) __workflowLongTasks.push(task.duration);
        }).observe({type: 'longtask'});
    }""", frames)
    page.evaluate(NATIVE_PHOTO_CAMERA_SCRIPT)
    page.evaluate("""() => {
        const NativePhoto = window.ImageCapture;
        window.ImageCapture = class extends NativePhoto {
            takePhoto(settings) {
                __workflowCamera.captures.push({at: performance.now(), mode: __workflowCamera.mode});
                return super.takePhoto(settings);
            }
        };
    }""")
    observe_document_scan_requests(page)


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
@pytest.mark.parametrize("degraded,preview_size,guidance_size,viewport", [
    (False, (768, 960), (768, 960), (390, 844)), (True, (768, 960), (768, 960), (390, 844)),
    (False, (360, 480), (360, 480), (390, 844)), (False, (1536, 1920), (1024, 1280), (390, 844)),
    (False, (1920, 1080), (1280, 720), (360, 698)), (False, (1920, 1080), (1280, 720), (800, 360)),
], ids=["clear", "scaled-dim-jpeg", "low-resolution-preview", "high-resolution-preview",
        "wide-camera-portrait-guide", "wide-camera-landscape-guide"])
def test_full_printed_page_guidance_capture_and_verification(browser, printed_workflow_page, path, degraded, preview_size, guidance_size, viewport):
    context = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]}, service_workers="allow")
    try:
        context.route("**/api/keys/default", lambda route: route.fulfill(json={"public_key": PUBLIC_KEY}))
        page = context.new_page()
        page.goto(os.environ.get("QRED_BASE_URL", "http://localhost:3000") + path, wait_until="networkidle")
        if path != "/":
            page.locator("#publicKeyFileInput").set_input_files({
                "name": "public.txt", "mimeType": "text/plain", "buffer": PUBLIC_KEY.encode(),
            })
        prepare_text_for_offline(page)
        install_changing_camera(page, camera_frames(printed_workflow_page, degraded=degraded, preview_size=preview_size))
        page.get_by_role("button", name="Check document", exact=True).click()
        guide = page.locator(".ar-scan-feedback, #pageGuideHint").first
        expect(guide).to_contain_text("four page corners", timeout=15000)
        if degraded:
            # Deliver one sharp frame, then stop the camera feed entirely.
            page.evaluate("__showWorkflowFrame('frozen')")
            expect(guide).to_contain_text("Keep the page in view")
            page.wait_for_timeout(800)
            assert page.evaluate("__syntheticStillRequests.length") == 0
        # End on a clipped frame so the next page must qualify from scratch.
        rejected = [("soft", "edges look soft"), ("moving", "Keep the page in view"), ("clipped", "four page corners")]
        if degraded:
            rejected.insert(1, ("soft-print", "printing looks blurry"))
        for mode, advice in rejected:
            page.evaluate("mode => __showWorkflowFrame(mode)", mode)
            expect(guide).to_contain_text(advice, timeout=10000)
            before = page.evaluate("__documentScanRequests.filter(request => request.live).length")
            page.wait_for_timeout(800)
            page.wait_for_function("before => __documentScanRequests.filter(request => request.live).length >= before + 5", arg=before)
            assert page.evaluate("__syntheticStillRequests.length") == 0
            expect(page.locator(".page-check-list button")).to_have_count(0)

        started = time.monotonic()
        clear_mode = "handheld" if degraded else "clear"
        if preview_size[0] > preview_size[1]:
            clear_mode = "guide"
        page.evaluate("mode => { __workflowLongTasks.length = 0; __showWorkflowFrame(mode); }", clear_mode)
        # No Capture now click, file picker, seal injection, or decoded result.
        review = page.get_by_role("region", name="Review Page 1 of 1", exact=True)
        expect(review).to_be_visible(timeout=15000)
        authenticated = time.monotonic()
        expect(review.locator("h3").first).to_contain_text("Seal authenticated")
        expect(review.locator(".photo-summary.matches, .photo-summary.uncertain")).to_have_count(1, timeout=20000)
        finished = time.monotonic()
        print("Synthetic OCR review: " + review.inner_text())
        # Production pages have a navigation caption. Its visible review warning
        # must remain, even when every signed document word agrees exactly.
        # Do not turn that conservative result into an unconditional green match.
        review.get_by_label("Show matching words too", exact=True).check()
        expected_words = [word for line in LINES for word in line.split()]
        words = review.locator('.photo-stage svg[aria-label="Text comparison highlights"] .photo-word')
        expect(words).to_have_count(len(expected_words))
        assert words.evaluate_all("nodes => nodes.map(node => node.getAttribute('aria-label'))") == [
            "Matching text: " + word for word in expected_words]
        assert review.locator(".photo-differences").inner_text() == ""
        expect(review.locator(".photo-legend .matched")).to_have_text(f"Matching: {len(expected_words)}")
        expect(review.locator(".photo-legend .different")).to_have_text("Different or extra: 0")
        expect(review.locator(".photo-legend .uncertain")).to_have_text("Uncertain: 0")
        expect(review.locator(".reading-caution, .photo-retries")).to_have_count(0)
        if review.locator(".photo-summary").inner_text() == "Some readings need review":
            expect(review.locator(".photo-markings")).to_be_visible()
            expect(review.locator(".photo-markings")).to_contain_text("Verify")
        else:
            expect(review.locator(".photo-summary")).to_have_text("Recognized text matches the signed text")
        previews = page.evaluate("__documentScanRequests.filter(request => request.live)")
        assert previews and all((request["width"], request["height"]) == guidance_size for request in previews)
        decoded = assert_document_preview_not_decoded(page)
        assert len(decoded) == 1, decoded
        assert (decoded[0]["width"], decoded[0]["height"]) == (2400, 3000)
        assert page.evaluate("__syntheticStillRequests.length") == 1
        assert page.evaluate("__workflowCamera.captures[0].mode") == clear_mode
        hold_ms = page.evaluate("__workflowCamera.captures[0].at - __workflowCamera.clearAt")
        assert hold_ms >= 300
        assert page.evaluate("__workflowCamera.opens") == 1
        assert page.evaluate("__workflowCamera.tracks.every(track => track.readyState === 'ended')")
        longest_task = page.evaluate("Math.max(0, ...__workflowLongTasks)")
        print("Scanner workflow: " + json.dumps({"path": path, "degraded": degraded, "preview_size": preview_size,
            "valid_preview_to_shutter_ms": round(hold_ms), "guidance_to_authenticated_seconds": authenticated - started,
            "ocr_seconds": finished - authenticated, "longest_ui_task_ms": longest_task}))
        assert finished - started < 25, "Full-page camera capture and checking exceeded its CI guard"
        assert longest_task < 1000, "Scanner processing blocked the browser UI"
        page.get_by_role("button", name="Finish & clear", exact=True).click()
        expect(page.locator(".photo-stage img")).to_have_count(0)
    finally:
        context.close()
