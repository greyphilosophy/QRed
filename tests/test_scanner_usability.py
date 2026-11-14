"""Main-camera selection and cancellable, offline photo recovery in the built UI."""
import io
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import expect
from browser_helpers import show_seal_details, show_file_inputs, prepare_text_for_offline, BASE_URL, OfflineNetworkGuard, wait_for_offline_resources, NATIVE_PHOTO_CAMERA_SCRIPT


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
def test_main_camera_at_one_times_zoom_with_optional_flashlight(browser, path):
    context = browser.new_context(service_workers="block", viewport={"width": 393, "height": 873})
    try:
        page = context.new_page()
        page.goto(BASE_URL + path, wait_until="networkidle")
        page.evaluate("""generic => {
            window.cameraTest = { requests: [], controls: [], stopped: [] };
            let activeTrack;
            const makeStream = (label, id) => {
                const canvas = document.createElement('canvas'); canvas.width = 360; canvas.height = 480;
                canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
                const stream = canvas.captureStream(10), [track] = stream.getVideoTracks();
                activeTrack = track;
                Object.defineProperty(track, 'label', { value: label });
                let torch = false;
                track.getSettings = () => ({ deviceId: id, torch });
                track.getCapabilities = () => ({ focusMode: ['continuous'], zoom: { min: 1, max: 5 }, torch: true });
                track.applyConstraints = constraints => {
                    cameraTest.controls.push({ id, constraints });
                    if (constraints.torch) {
                        torch = constraints.torch.exact;
                        return Promise.resolve();
                    }
                    return new Promise(() => {}); // Driver never acknowledges autofocus.
                };
                const stop = track.stop.bind(track);
                track.stop = () => { cameraTest.stopped.push(id); stop(); };
                return stream;
            };
            navigator.mediaDevices.getUserMedia = async constraints => {
                cameraTest.requests.push(constraints);
                if (activeTrack?.readyState === 'live') return new Promise(() => {});
                const main = constraints.video.deviceId?.exact === 'main';
                const label = generic ? 'Camera, facing back' : main ? 'Back Main Camera 1x' : 'Back Telephoto Camera';
                return makeStream(label, main ? 'main' : 'tele');
            };
            window.setCameraTestHidden = hidden => {
                Object.defineProperty(document, 'hidden', {configurable: true, value: hidden});
                Object.defineProperty(document, 'visibilityState', {configurable: true, value: hidden ? 'hidden' : 'visible'});
                document.dispatchEvent(new Event('visibilitychange'));
            };
            navigator.mediaDevices.enumerateDevices = async () => generic ? [
                { kind: 'videoinput', deviceId: 'tele', label: 'Camera, facing back', getCapabilities: () => ({focusMode: ['none']}) },
                { kind: 'videoinput', deviceId: 'main', label: 'Camera, facing back', getCapabilities: () => ({focusMode: ['continuous']}) },
            ] : [
                { kind: 'videoinput', deviceId: 'ultra', label: 'Back Ultra Wide Camera' },
                { kind: 'videoinput', deviceId: 'tele', label: 'Back Telephoto Camera' },
                { kind: 'videoinput', deviceId: 'main', label: 'Back Main Camera 1x' },
            ];
        }""", path == "/verify.htm")
        page.get_by_role("button", name="Check document", exact=True).click()
        page.wait_for_function("cameraTest.controls.length === 1")
        state = page.evaluate("cameraTest")
        assert state["requests"][0]["video"]["facingMode"] == {"ideal": "environment"}
        assert state["requests"][1]["video"]["deviceId"] == {"exact": "main"}
        assert state["controls"] == [{"id": "main", "constraints": {"advanced": [
            {"focusMode": "continuous"}, {"zoom": 1},
        ]}}]
        assert state["stopped"] == ["tele"]
        light = page.get_by_role("button", name="Flashlight off")
        expect(light).to_be_visible()
        light.click()
        expect(page.get_by_role("button", name="Flashlight on")).to_have_attribute("aria-pressed", "true")
        assert page.evaluate("cameraTest.controls.at(-1)") == {"id": "main", "constraints": {
            "torch": {"exact": True}, "advanced": [{"focusMode": "continuous"}, {"zoom": 1}]}}
        assert page.locator("video").evaluate("video => getComputedStyle(video).objectFit") == "contain"
        expect(page.locator(".ar-scan-feedback, #pageGuideHint").first).to_be_visible()
        # The same camera stays open while the phone rotates or its viewport
        # changes. The guide must fit the real image, not the black letterbox,
        # and must leave the advice and camera controls usable.
        for width, height in [(393, 873), (873, 393), (320, 568), (1280, 800)]:
            page.set_viewport_size({"width": width, "height": height})
            expect(page.locator(".page-scan-guide")).to_be_visible()
            page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
            geometry = page.evaluate("""() => {
                const video = document.querySelector('video'), view = video.getBoundingClientRect();
                const guide = document.querySelector('.page-scan-guide'), box = guide.getBoundingClientRect();
                const scale = Math.min(view.width / video.videoWidth, view.height / video.videoHeight);
                const w = video.videoWidth * scale, h = video.videoHeight * scale;
                const left = view.left + (view.width - w) / 2, top = view.top + (view.height - h) / 2;
                const overlaps = element => {
                    const other = element.getBoundingClientRect();
                    return box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top;
                };
                return {
                    insideImage: box.left >= left - 1 && box.right <= left + w + 1 && box.top >= top - 1 && box.bottom <= top + h + 1,
                    ratio: box.width / box.height,
                    centerOffset: [box.left + box.width / 2 - (left + w / 2), box.top + box.height / 2 - (top + h / 2)],
                    imageCoverage: box.width * box.height / (w * h),
                    overlappingControls: [...document.querySelectorAll('.ar-controls, .ar-close, .ar-scan-feedback, .controls, .page-scan-hint')]
                        .filter(element => !element.hidden && overlaps(element))
                        .map(element => ({ name: element.className, bounds: element.getBoundingClientRect().toJSON() })),
                    bounds: box.toJSON(),
                    animation: getComputedStyle(guide).animationName,
                    pointerEvents: getComputedStyle(guide).pointerEvents,
                };
            }""")
            assert geometry["insideImage"], (width, height, geometry)
            assert geometry["overlappingControls"] == [], (width, height, geometry)
            assert geometry["ratio"] == pytest.approx(8.5 / 11, abs=0.01)
            assert geometry["centerOffset"] == pytest.approx([0, 0], abs=1), geometry
            assert geometry["imageCoverage"] > .72, geometry
            assert geometry["animation"] == "none"
            assert geometry["pointerEvents"] == "none"
            expect(page.locator(".page-detected-outline")).to_have_count(0)
            # Capture advice can wrap or change height while detection updates.
            # This must not shift the manually aligned paper corners.
            stationary = page.evaluate("""async () => {
                const guide = document.querySelector('.page-scan-guide');
                const feedback = document.querySelector('.ar-scan-feedback, #pageGuideHint');
                const bounds = () => JSON.stringify(guide.getBoundingClientRect().toJSON());
                const before = bounds(), previous = feedback.style.minHeight;
                feedback.style.minHeight = '140px';
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const unchanged = bounds() === before;
                feedback.style.minHeight = previous;
                return unchanged;
            }""")
            assert stationary
        expect(page.get_by_text("Show all four page corners. Try a contrasting background, or use Capture now.", exact=True)).to_be_visible()
        page.evaluate("setCameraTestHidden(true)")
        assert page.locator("video").evaluate("video => video.srcObject === null")
        assert page.evaluate("cameraTest.stopped") == ["tele", "main"]
        page.evaluate("setCameraTestHidden(false)")
        page.wait_for_function("document.querySelector('video').readyState >= 2 && cameraTest.controls.length === 3")
        expect(page.get_by_role("button", name="Flashlight off")).to_have_attribute("aria-pressed", "false")
        page.get_by_role("button", name="Close" if path == "/" else "Stop camera", exact=True).click()
        expect(page.locator(".page-scan-guide")).not_to_be_visible()
        page.evaluate("() => { setCameraTestHidden(true); setCameraTestHidden(false); }")
        assert page.evaluate("cameraTest.stopped") == ["tele", "main", "tele", "main"]
        assert page.evaluate("cameraTest.requests.length") == 4
    finally:
        context.close()


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
@pytest.mark.parametrize("mode", ["late-torch", "shutter-only", "ignored"])
def test_light_stays_discoverable_after_the_mobile_preview_starts(browser, path, mode):
    context = browser.new_context(service_workers="block", viewport={"width": 360, "height": 780})
    try:
        page = context.new_page()
        page.goto(BASE_URL + path, wait_until="networkidle")
        page.evaluate("""mode => {
            navigator.mediaDevices.enumerateDevices = async () => [];
            window.lightRequests = [];
            window.ImageCapture = class {
                async getPhotoCapabilities() {
                    return {fillLightMode: mode === 'shutter-only' && document.querySelector('video').readyState >= 2
                        ? ['off', 'flash'] : []};
                }
            };
            navigator.mediaDevices.getUserMedia = async () => {
                const canvas = document.createElement('canvas');
                canvas.width = 360; canvas.height = 480;
                canvas.getContext('2d').fillRect(0, 0, 360, 480);
                const stream = canvas.captureStream(10), [track] = stream.getVideoTracks();
                let torch = false;
                const advertisesTorch = () => mode === 'late-torch' && document.querySelector('video')?.readyState >= 2;
                track.getSettings = () => advertisesTorch() ? {torch} : {};
                track.getCapabilities = () => advertisesTorch() ? {torch: [false, true]} : {};
                track.applyConstraints = async request => {
                    lightRequests.push(request);
                    if (advertisesTorch()) torch = request.torch?.exact ?? request.advanced[0].torch;
                };
                return stream;
            };
        }""", mode)
        page.get_by_role("button", name="Check document", exact=True).click()
        labels = {"late-torch": "Flashlight off", "shutter-only": "Photo flash off", "ignored": "Try flashlight"}
        light = page.get_by_role("button", name=labels[mode], exact=True)
        expect(light).to_be_visible()
        assert page.evaluate("lightRequests") == []
        light.click()
        if mode == "ignored":
            light = page.get_by_role("button", name="Flashlight unavailable")
            expect(light).to_be_visible()
            expect(light).to_have_attribute("aria-pressed", "false")
            expect(page.get_by_text("For flash, take a photo in your phone’s Camera app, then select Choose photo.")).to_be_visible()
            expect(page.get_by_role("button", name="Capture now")).to_be_enabled()
            with page.expect_file_chooser():
                page.get_by_role("button", name="Choose photo").click()
        else:
            on = page.get_by_role("button", name=labels[mode].replace(" off", " on"), exact=True)
            expect(on).to_have_attribute("aria-pressed", "true")
            on.click()
            expect(light).to_have_attribute("aria-pressed", "false")
            page.get_by_role("button", name="Close" if path == "/" else "Stop camera", exact=True).click()
            expect(light).not_to_be_visible()
    finally:
        context.close()


def test_large_photo_can_be_cancelled_then_another_seal_verified_offline(browser):
    # A synthetic 12 MP page with no seal exercises the real exhaustive decoder.
    # The private printer/phone trial photographs are deliberately not fixtures.
    photo = Image.new("RGB", (3000, 4000), (55, 55, 55))
    draw = ImageDraw.Draw(photo)
    draw.rectangle((200, 150, 2800, 3850), fill="white")
    font = ImageFont.truetype("DejaVuSans.ttf", 24)
    for row in range(90):
        draw.text((320, 250 + row * 36), "Synthetic document for cancellation. " * 8, fill="black", font=font)
    buffer = io.BytesIO()
    photo.save(buffer, format="JPEG", quality=90)
    context = browser.new_context(service_workers="allow", viewport={"width": 393, "height": 873})
    try:
        guard = OfflineNetworkGuard(context)
        page = context.new_page()
        page.goto(BASE_URL, wait_until="networkidle")
        wait_for_offline_resources(page, photo=True)
        prepare_text_for_offline(page)
        guard.block()
        page.evaluate("""() => {
            window.scanHeartbeat = 0;
            setInterval(() => scanHeartbeat++, 25);
        }""")
        show_file_inputs(page)
        page.get_by_label("Choose QR image", exact=True).scroll_into_view_if_needed()
        page.get_by_label("Choose QR image", exact=True).set_input_files({
            "name": "synthetic-large-page.jpg", "mimeType": "image/jpeg", "buffer": buffer.getvalue(),
        })
        expect(page.get_by_role("progressbar", name="Photo seal scan")).to_be_visible()
        expect(page.get_by_role("progressbar", name="Photo seal scan")).to_be_in_viewport()
        expect(page.get_by_role("button", name="Cancel photo scan", exact=True)).to_be_in_viewport()
        assert page.get_by_role("progressbar", name="Photo seal scan").get_attribute("value") is None
        # The worker can stay in one expensive step while the main-thread clock
        # keeps advancing. No percentage is invented from its time budget.
        first_time = page.locator(".photo-scan-timing").inner_text()
        page.wait_for_function("before => document.querySelector('.photo-scan-timing')?.textContent !== before",
                               arg=first_time, timeout=2000)
        expect(page.locator(".photo-scan-step")).to_be_visible()
        ticks = page.evaluate("scanHeartbeat")
        page.wait_for_function("ticks => scanHeartbeat > ticks + 3", arg=ticks, timeout=2000)
        # Replacing an active photo must reveal its progress again after the
        # user returns to the lower file input, without relying on busy toggling.
        page.get_by_label("Choose QR image", exact=True).scroll_into_view_if_needed()
        page.get_by_label("Choose QR image", exact=True).set_input_files({
            "name": "synthetic-replacement-page.jpg", "mimeType": "image/jpeg", "buffer": buffer.getvalue(),
        })
        expect(page.get_by_role("progressbar", name="Photo seal scan")).to_be_in_viewport()
        expect(page.get_by_role("button", name="Cancel photo scan", exact=True)).to_be_in_viewport()
        page.get_by_role("button", name="Cancel photo scan", exact=True).click(timeout=2000)
        expect(page.get_by_text("Photo scan cancelled.", exact=True)).to_be_visible()
        expect(page.get_by_role("button", name="Cancel photo scan", exact=True)).to_have_count(0)
        expect(page.get_by_role("progressbar", name="Photo seal scan")).to_have_count(0)

        fixture = Path(__file__).parent / "fixtures" / "compact-qr" / "invoice-footer-300dpi.png"
        show_file_inputs(page)
        page.get_by_label("Choose QR image", exact=True).set_input_files(fixture)
        page.get_by_label("Open issuer public key file", exact=True).set_input_files({
            "name": "issuer-public.txt", "mimeType": "text/plain",
            "buffer": b"eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=",
        })
        show_seal_details(page)
        expect(page.get_by_role("heading", name="Seal authenticated", exact=True)).to_be_visible(timeout=20000)
        expect(page.locator(".verification-result pre")).to_contain_text("Approved total: $123.45")
        guard.assert_quiet()
    finally:
        context.close()


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
def test_live_worker_has_no_backlog_and_capture_can_resume_the_same_camera_offline(browser, path):
    context = browser.new_context(service_workers="allow", viewport={"width": 393, "height": 873})
    try:
        guard = OfflineNetworkGuard(context)
        page = context.new_page()
        page.goto(BASE_URL + path, wait_until="networkidle")
        wait_for_offline_resources(page, photo=True)
        page.evaluate("""() => {
            window.liveTest = { requests: 0, responses: 0, pending: 0, maxPending: 0,
                readsWhileBusy: 0, opens: 0, ticks: 0, terminated: 0, decodedVideo: 0, photos: [], stages: [] };
            const NativeWorker = window.Worker;
            window.Worker = class extends NativeWorker {
                pending = false;
                constructor(...args) {
                    super(...args);
                    this.addEventListener('message', event => {
                        if (event.data.scanStage) liveTest.stages.push(event.data.scanStage);
                        if (this.pending) {
                            this.pending = false; liveTest.pending--; liveTest.responses++;
                        }
                    });
                }
                postMessage(message, transfer) {
                    if (message.live) {
                        if (!message.captureOnly) liveTest.decodedVideo++;
                        this.pending = true; liveTest.requests++; liveTest.pending++;
                        liveTest.maxPending = Math.max(liveTest.maxPending, liveTest.pending);
                    }
                    if (message.image && !message.live && !message.prepareReading)
                        liveTest.photos.push([message.image.width, message.image.height]);
                    super.postMessage(message, transfer);
                }
                terminate() {
                    if (this.pending) { this.pending = false; liveTest.pending--; }
                    liveTest.terminated++;
                    super.terminate();
                }
            };
            const read = CanvasRenderingContext2D.prototype.getImageData;
            CanvasRenderingContext2D.prototype.getImageData = function(...args) {
                if (this.canvas.matches('.ar-camera canvas, #scanCanvas') && liveTest.pending) liveTest.readsWhileBusy++;
                return read.apply(this, args);
            };
            const native = document.createElement('canvas'); native.width = 2160; native.height = 3840;
            window.__syntheticNativePhoto = native;
            const ctx = native.getContext('2d'); ctx.scale(2, 2);
            ctx.fillStyle = '#454545'; ctx.fillRect(0, 0, 1080, 1920);
            ctx.fillStyle = '#fafafa'; ctx.fillRect(100, 350, 880, 1160);
            ctx.fillStyle = '#333'; ctx.font = '24px sans-serif';
            for (let row = 0; row < 24; row++) ctx.fillText('Synthetic page with text but no QR seal.', 150, 440 + row * 36);
            const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1920;
            canvas.getContext('2d').drawImage(native, 0, 0, canvas.width, canvas.height);
            const stream = canvas.captureStream(10);
            window.liveTestStream = stream;
            setInterval(() => canvas.getContext('2d').drawImage(native, 0, 0, canvas.width, canvas.height), 100);
            navigator.mediaDevices.getUserMedia = async () => { liveTest.opens++; return stream; };
            navigator.mediaDevices.enumerateDevices = async () => [];
            setInterval(() => liveTest.ticks++, 25);
        }""")
        page.evaluate(NATIVE_PHOTO_CAMERA_SCRIPT)
        prepare_text_for_offline(page)
        guard.block()
        page.get_by_role("button", name="Check document", exact=True).click()
        page.wait_for_function("liveTest.responses >= 2", timeout=15000)
        page.get_by_role("button", name="Capture now", exact=True).click()
        expect(page.get_by_role("button", name="Cancel and resume camera", exact=True)).to_be_visible()
        page.wait_for_function("liveTest.photos.length === 1", timeout=5000)
        page.wait_for_function("liveTest.stages.length > 0", timeout=5000)
        notice = page.get_by_text("Photo captured. You can move your phone.", exact=True)
        expect(notice).to_be_in_viewport()
        expect(page.locator(".page-scan-guide-area")).to_be_hidden()
        expect(page.get_by_role("progressbar", name="Photo seal scan")).to_be_visible()
        assert page.get_by_role("progressbar", name="Photo seal scan").get_attribute("value") is None
        initial_time = page.locator(".photo-scan-timing").inner_text()
        page.wait_for_function("before => document.querySelector('.photo-scan-timing')?.textContent !== before",
                               arg=initial_time, timeout=2000)
        # On mobile the progress panel must leave the cancellation control clear.
        if path == "/":
            progress_box = page.locator(".photo-scan-progress").bounding_box()
            controls_box = page.locator(".ar-display-scanning .ar-controls").bounding_box()
            assert progress_box and controls_box
            assert progress_box["y"] + progress_box["height"] <= controls_box["y"]
        assert page.evaluate("liveTest.pending") == 0
        ticks = page.evaluate("liveTest.ticks")
        page.wait_for_function("ticks => liveTest.ticks > ticks + 2", arg=ticks, timeout=2000)
        before = page.evaluate("liveTest.requests")
        page.get_by_role("button", name="Cancel and resume camera", exact=True).click()
        expect(notice).to_have_count(0)
        expect(page.locator(".page-scan-guide-area")).to_be_visible()
        expect(page.get_by_role("button", name="Capture now", exact=True)).to_be_visible()
        expect(page.get_by_role("progressbar", name="Photo seal scan")).not_to_be_visible()
        page.wait_for_function("before => liveTest.requests > before", arg=before, timeout=3000)
        assert page.evaluate("liveTestStream.getTracks().every(track => track.readyState === 'live')")
        state = page.evaluate("liveTest")
        assert state["opens"] == 1
        assert state["maxPending"] == 1
        assert state["readsWhileBusy"] == 0
        assert state["decodedVideo"] == 0
        assert state["photos"] == [[2160, 3840]]
        assert 1 <= page.evaluate("__syntheticStillRequests.length") <= 3
        page.get_by_role("button", name="Close" if path == "/" else "Stop camera", exact=True).click()
        assert page.evaluate("liveTestStream.getTracks().every(track => track.readyState === 'ended')")
        assert page.evaluate("liveTest.pending") == 0
        assert page.evaluate("liveTest.terminated") >= 1
        guard.assert_quiet()
    finally:
        context.close()
