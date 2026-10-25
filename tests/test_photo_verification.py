"""Real OCR, signed QR payloads, image highlights, and offline privacy.

All fixtures are synthetic. No personal document or uploaded QR is used.
"""
import base64
import io
import json
import os
import subprocess
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import expect
from browser_helpers import OfflineNetworkGuard, wait_for_offline_resources

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_KEY = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q="
TEXT = "Invoice 1042\nAccount 123456\nApproved total 123.45\nPayment due Friday"


def page_image(text):
    image = Image.new("RGB", (1200, 1600), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype("DejaVuSans.ttf", 40)
    for index, line in enumerate(text.splitlines()):
        draw.text((100, 160 + index * 100), line, font=font, fill="black")
    output = io.BytesIO()
    image.save(output, format="PNG")
    return {"name": "synthetic-page.png", "mimeType": "image/png", "buffer": output.getvalue()}


@pytest.fixture(scope="module")
def sealed_text():
    source = """
      import { createServer } from 'vite';
      import { PNG } from 'pngjs';
      const server = await createServer({ server: { middlewareMode: true } });
      const { createQRedSeals } = await server.ssrLoadModule('/src/qredSealer.js');
      const { createQRedQrSymbol } = await server.ssrLoadModule('/src/qredQr.js');
      let input = ''; for await (const chunk of process.stdin) input += chunk;
      const sealed = await createQRedSeals({ content: JSON.parse(input),
        privateKey: 'txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=',
        publicKey: 'eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=' });
      const { modules } = createQRedQrSymbol(sealed.seals[0]);
      const size = (modules.size + 8) * 6;
      const image = new PNG({ width: size, height: size }); image.data.fill(255);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const r = Math.floor(y / 6) - 4, c = Math.floor(x / 6) - 4;
        if (r >= 0 && c >= 0 && r < modules.size && c < modules.size && modules.get(r, c)) {
          const i = (y * size + x) * 4; image.data[i] = image.data[i + 1] = image.data[i + 2] = 0;
        }
      }
      console.log(JSON.stringify({ seals: sealed.seals, qr: PNG.sync.write(image).toString('base64') }));
      await server.close();
    """
    result = subprocess.run(["node", "--input-type=module", "-e", source], input=json.dumps(TEXT),
                            cwd=ROOT / "frontend", text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def verify_fixture(page, path, sealed_text):
    if path == "/":
        page.get_by_label("Choose QR image", exact=True).set_input_files({
            "name": "synthetic-seal.png", "mimeType": "image/png", "buffer": base64.b64decode(sealed_text["qr"]),
        })
        page.get_by_label("Open issuer public key file", exact=True).set_input_files({
            "name": "issuer-public.txt", "mimeType": "text/plain", "buffer": PUBLIC_KEY.encode(),
        })
        expect(page.get_by_role("heading", name="VALID", exact=True)).to_be_visible()
    else:
        result = page.evaluate("([seals, key]) => window.__qredTestVerify(seals, key)", [sealed_text["seals"], PUBLIC_KEY])
        assert result["status"] == "VALID"
    expect(page.get_by_label("Signed page to compare")).to_be_visible()


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
@pytest.mark.parametrize("offline", [False, True], ids=["network-guard", "airplane-mode"])
def test_photo_comparison_reads_real_pixels_offline(browser, sealed_text, path, offline):
    context = browser.new_context(service_workers="allow", viewport={"width": 430, "height": 932})
    try:
        base_url = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        guard = OfflineNetworkGuard(context, base_url)
        page = context.new_page()
        page.goto(base_url + path, wait_until="networkidle")
        wait_for_offline_resources(page)
        page.get_by_role("button", name="Load text recognition", exact=True).click()
        expect(page.get_by_role("button", name="Text recognition ready", exact=True)).to_be_visible(timeout=60000)
        page.wait_for_load_state("networkidle")
        guard.check_instrumentation(page)
        guard.block(offline=offline)
        verify_fixture(page, path, sealed_text)

        picker = page.get_by_label("Choose page photo", exact=True)
        # The homepage's uploaded seal also starts an automatic comparison.
        # Wait for its result, not the brief enabled state before OCR begins:
        # set_input_files can dispatch a change even after a picker is disabled.
        if path == "/":
            expect(page.locator(".photo-summary")).to_be_visible(timeout=60000)
        expect(picker).to_be_enabled(timeout=60000)
        picker.set_input_files(page_image(TEXT))
        expect(page.locator(".photo-summary")).to_have_text("Recognized text matches the signed text", timeout=60000)
        expect(page.locator(".photo-word.matched")).to_have_count(10)
        expect(page.locator(".photo-word.different")).to_have_count(0)
        assert page.locator(".photo-stage img").evaluate("img => img.naturalWidth") == 1200

        picker.set_input_files(page_image(TEXT.replace("123456", "123457")))
        expect(page.locator(".photo-summary")).to_contain_text("Differences found", timeout=60000)
        number = page.get_by_role("button", name="Different or extra text: 123457", exact=True)
        expect(number).to_be_visible()
        # The box must be on the account-number line in the actual image.
        assert 250 <= float(number.get_attribute("y")) <= 300
        expect(page.locator(".photo-differences")).to_contain_text("123456")
        number.click()
        expect(page.locator(".photo-selected")).to_contain_text("123457")

        picker.set_input_files(page_image(TEXT.replace("Payment due Friday", "")))
        expect(page.locator(".photo-differences")).to_contain_text("Payment due Friday", timeout=60000)
        expect(page.locator(".photo-summary")).to_contain_text("Differences found")

        picker.set_input_files(page_image(""))
        expect(page.locator(".photo-summary")).to_contain_text("No text could be read", timeout=60000)
        expect(page.locator(".photo-word.matched")).to_have_count(0)
        page.get_by_role("button", name="Clear photo", exact=True).click()
        expect(page.locator(".photo-stage img")).to_have_count(0)
        page.wait_for_load_state("networkidle")
        guard.assert_quiet()
    finally:
        context.close()


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
@pytest.mark.parametrize("preload", [True, False], ids=["ready-offline", "load-after-scan"])
def test_watermark_scan_captures_original_page_and_compares_automatically(browser, sealed_text, path, preload, tmp_path):
    context = browser.new_context(service_workers="block", viewport={"width": 430, "height": 932})
    try:
        context.route("**/api/keys/default", lambda route: route.fulfill(json={
            "public_key": PUBLIC_KEY, "key_id": "da522162396ab2d0",
        }))
        base_url = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        page = context.new_page()
        page.goto(base_url + path, wait_until="networkidle")
        if path == "/verify.htm":
            # Preload the issuer key locally before entering airplane mode.
            page.locator("#publicKeyFileInput").set_input_files({
                "name": "issuer-public.txt", "mimeType": "text/plain", "buffer": PUBLIC_KEY.encode(),
            })
            expect(page.locator("#publicKeyFileStatus")).to_contain_text("Public key opened")
        if preload:
            page.get_by_role("button", name="Load text recognition", exact=True).click()
            expect(page.get_by_role("button", name="Text recognition ready", exact=True)).to_be_visible(timeout=60000)
            context.set_offline(True)

        # The original camera view includes readable black text and a pale QR.
        # Altering the paper does not alter the authentic reference in the seal.
        paper = Image.open(io.BytesIO(page_image(TEXT.replace("123456", "123457"))["buffer"]))
        qr = Image.open(io.BytesIO(base64.b64decode(sealed_text["qr"]))).convert("L")
        qr = qr.point(lambda value: 224 if value < 128 else 255).resize((900, 900), Image.Resampling.NEAREST)
        paper.paste(qr.convert("RGB"), (150, 620))
        image = io.BytesIO()
        paper.save(image, format="PNG")
        url = "data:image/png;base64," + base64.b64encode(image.getvalue()).decode()
        awaitable_source = """async url => {
            const image = new Image(); image.src = url; await image.decode();
            const frame = document.createElement('canvas'); frame.width = image.width; frame.height = image.height;
            frame.getContext('2d').drawImage(image, 0, 0);
            const stream = frame.captureStream(15);
            navigator.mediaDevices.getUserMedia = async () => stream;
            navigator.mediaDevices.enumerateDevices = async () => [];
            window.__syntheticCameraFrame = frame;
        }"""
        page.evaluate(awaitable_source, url)
        requests = []
        context.on("request", lambda request: requests.append(request.url) if request.url.startswith("http") else None)
        page.get_by_role("button", name="Start scanning" if path == "/" else "Scan QR Code", exact=True).click()
        expect(page.locator(".verification-result h3" if path == "/" else "#resultStatus")).to_have_text("VALID", timeout=30000)
        expect(page.locator(".photo-stage img")).to_be_visible(timeout=30000)
        expect(page.get_by_label("Captured scan image")).to_have_value("1")
        # The saved photo must not reference the scanner's mutable canvas.
        page.evaluate("""() => {
            const canvas = window.__syntheticCameraFrame, ctx = canvas.getContext('2d');
            ctx.fillStyle = 'red'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        }""")
        if not preload:
            expect(page.locator(".photo-summary")).to_have_count(0)
            page.get_by_role("button", name="Load text recognition", exact=True).click()
        expect(page.locator(".photo-summary")).to_contain_text("Differences found", timeout=60000)
        expect(page.get_by_role("button", name="Different or extra text: 123457", exact=True)).to_be_visible()
        expect(page.locator(".photo-differences")).to_contain_text("123456")
        colours = page.locator(".photo-stage img").evaluate("""image => {
            const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
            const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let black = false, pale = false;
            for (let i = 0; i < pixels.length; i += 4) {
                black ||= pixels[i] === 0 && pixels[i + 1] === 0 && pixels[i + 2] === 0;
                pale ||= pixels[i] === 224 && pixels[i + 1] === 224 && pixels[i + 2] === 224;
            }
            return { black, pale, corner: Array.from(pixels.slice(0, 3)) };
        }""")
        assert colours == {"black": True, "pale": True, "corner": [255, 255, 255]}
        if preload:
            assert requests == [], "Unexpected network activity during offline capture: " + repr(requests)
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), page.evaluate("""() =>
            [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > innerWidth)
              .map(el => ({tag: el.tagName, id: el.id, classes: el.className, width: el.getBoundingClientRect().width})).slice(0, 15)
        """)
        page.screenshot(path=str(tmp_path / "scan-photo.png"), full_page=True)
        page.get_by_role("button", name="Clear collected seals" if path == "/" else "New Scan", exact=True).click()
        expect(page.locator(".photo-stage img")).to_have_count(0)
        expect(page.get_by_label("Captured scan image")).to_have_count(0)
    finally:
        context.close()


def test_missing_ocr_language_resource_fails_and_retries(browser):
    context = browser.new_context(service_workers="block")
    try:
        page = context.new_page()
        base_url = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        context.route("**/ocr/v1/eng.traineddata.gz", lambda route: route.fulfill(status=404, body="Unavailable"))
        page.goto(base_url, wait_until="networkidle")
        page.get_by_role("button", name="Load text recognition", exact=True).click()
        expect(page.get_by_role("alert")).to_contain_text("could not finish", timeout=20000)
        context.unroute("**/ocr/v1/eng.traineddata.gz")
        page.get_by_role("button", name="Load text recognition", exact=True).click()
        expect(page.get_by_role("button", name="Text recognition ready", exact=True)).to_be_visible(timeout=60000)
    finally:
        context.close()
