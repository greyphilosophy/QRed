"""Real OCR, signed QR payloads, image highlights, and offline privacy.

All fixtures are synthetic. No personal document or uploaded QR is used.
"""
import base64
import io
import json
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import expect

os.environ["PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS"] = "1"
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
        origin = urlsplit(base_url)
        attempts, loading = [], True

        def guard(route):
            target = urlsplit(route.request.url)
            if (loading and route.request.method == "GET" and not route.request.post_data
                    and target.netloc == origin.netloc and target.scheme == origin.scheme and not target.query):
                route.continue_()
            else:
                attempts.append(f"{route.request.method} {route.request.url}")
                route.abort("blockedbyclient")

        context.route(re.compile(r"^https?://"), guard)
        context.route_web_socket(re.compile(r"^wss?://"), lambda socket: attempts.append(socket.url))
        page = context.new_page()
        page.goto(base_url + path, wait_until="networkidle")
        page.wait_for_function("navigator.serviceWorker.controller?.state === 'activated'")
        page.get_by_role("button", name="Load text recognition", exact=True).click()
        expect(page.get_by_role("button", name="Text recognition ready", exact=True)).to_be_visible(timeout=60000)
        page.wait_for_load_state("networkidle")
        assert attempts == []
        loading = False
        # Confirm that the guard observes the page AND its service worker.
        page.evaluate("() => fetch('/__photo_probe__').catch(() => {})")
        context.service_workers[0].evaluate("() => fetch('/__photo_worker_probe__').catch(() => {})")
        assert any("__photo_probe__" in entry for entry in attempts)
        assert any("__photo_worker_probe__" in entry for entry in attempts)
        attempts.clear()
        context.set_offline(offline)
        verify_fixture(page, path, sealed_text)

        picker = page.get_by_label("Choose page photo", exact=True)
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
        assert attempts == [], "Network requests during photo comparison: " + repr(attempts)
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
