"""Main-camera selection and cancellable, offline photo recovery in the built UI."""
import io
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import expect
from browser_helpers import BASE_URL, OfflineNetworkGuard, wait_for_offline_resources


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
def test_main_camera_at_one_times_zoom_without_flashlight(browser, path):
    context = browser.new_context(service_workers="block", viewport={"width": 393, "height": 873})
    try:
        page = context.new_page()
        page.goto(BASE_URL + path, wait_until="networkidle")
        page.evaluate("""() => {
            window.cameraTest = { requests: [], controls: [], stopped: [] };
            const makeStream = (label, id) => {
                const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
                canvas.getContext('2d').fillRect(0, 0, 64, 64);
                const stream = canvas.captureStream(10), [track] = stream.getVideoTracks();
                Object.defineProperty(track, 'label', { value: label });
                track.getSettings = () => ({ deviceId: id });
                track.getCapabilities = () => ({ focusMode: ['continuous'], zoom: { min: 1, max: 5 }, torch: true });
                track.applyConstraints = async constraints => cameraTest.controls.push({ id, constraints });
                const stop = track.stop.bind(track);
                track.stop = () => { cameraTest.stopped.push(id); stop(); };
                return stream;
            };
            const tele = makeStream('Back Telephoto Camera', 'tele');
            const main = makeStream('Back Main Camera 1x', 'main');
            navigator.mediaDevices.getUserMedia = async constraints => {
                cameraTest.requests.push(constraints);
                return constraints.video.deviceId?.exact === 'main' ? main : tele;
            };
            navigator.mediaDevices.enumerateDevices = async () => [
                { kind: 'videoinput', deviceId: 'ultra', label: 'Back Ultra Wide Camera' },
                { kind: 'videoinput', deviceId: 'tele', label: 'Back Telephoto Camera' },
                { kind: 'videoinput', deviceId: 'main', label: 'Back Main Camera 1x' },
            ];
        }""")
        page.get_by_role("button", name="Start scanning" if path == "/" else "Scan QR Code", exact=True).click()
        page.wait_for_function("cameraTest.controls.length === 1")
        state = page.evaluate("cameraTest")
        assert state["requests"][0]["video"]["facingMode"] == {"ideal": "environment"}
        assert state["requests"][1]["video"]["deviceId"] == {"exact": "main"}
        assert state["controls"] == [{"id": "main", "constraints": {"advanced": [
            {"focusMode": "continuous"}, {"zoom": 1},
        ]}}]
        assert state["stopped"] == ["tele"]
        expect(page.get_by_role("button", name="Flashlight", exact=False)).to_have_count(0)
        assert page.locator("video").evaluate("video => getComputedStyle(video).objectFit") == "contain"
        page.get_by_role("button", name="Close" if path == "/" else "Stop", exact=True).click()
        assert page.evaluate("cameraTest.stopped") == ["tele", "main"]
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
        guard.block()
        page.evaluate("""() => {
            window.scanHeartbeat = 0;
            setInterval(() => scanHeartbeat++, 25);
        }""")
        page.get_by_label("Choose QR image", exact=True).set_input_files({
            "name": "synthetic-large-page.jpg", "mimeType": "image/jpeg", "buffer": buffer.getvalue(),
        })
        expect(page.get_by_role("status").filter(has_text="Reading photo")).to_be_visible()
        ticks = page.evaluate("scanHeartbeat")
        page.wait_for_function("ticks => scanHeartbeat > ticks + 3", arg=ticks, timeout=2000)
        page.get_by_role("button", name="Cancel photo scan", exact=True).click(timeout=2000)
        expect(page.get_by_text("Photo scan cancelled.", exact=True)).to_be_visible()
        expect(page.get_by_role("button", name="Cancel photo scan", exact=True)).to_have_count(0)

        fixture = Path(__file__).parent / "fixtures" / "compact-qr" / "invoice-footer-300dpi.png"
        page.get_by_label("Choose QR image", exact=True).set_input_files(fixture)
        page.get_by_label("Open issuer public key file", exact=True).set_input_files({
            "name": "issuer-public.txt", "mimeType": "text/plain",
            "buffer": b"eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=",
        })
        expect(page.get_by_role("heading", name="VALID", exact=True)).to_be_visible(timeout=20000)
        expect(page.locator(".verification-result pre")).to_contain_text("Approved total: $123.45")
        guard.assert_quiet()
    finally:
        context.close()
