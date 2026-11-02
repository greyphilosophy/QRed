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
      const pages = [];
      for (const pageNumber of [1, 2]) {
      const sealed = await createQRedSeals({ content: JSON.parse(input), timestamp: '2026-11-02T12:00:00Z',
        pageContext: { pageNumber, pageCount: 2, documentRoot: 'ab'.repeat(32) },
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
      pages.push({ seals: sealed.seals, qr: PNG.sync.write(image).toString('base64') });
      }
      console.log(JSON.stringify(pages));
      await server.close();
    """
    result = subprocess.run(["node", "--input-type=module", "-e", source], input=json.dumps(TEXT),
                            cwd=ROOT / "frontend", text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def prepare_reader(page):
    page.get_by_text("Prepare for offline checking", exact=True).click()
    page.get_by_role("button", name="Prepare offline checking", exact=True).click()
    expect(page.get_by_role("button", name="Offline text checking ready", exact=True)).to_be_visible(timeout=60000)


def camera_paper(page, text, qr_bytes):
    paper = Image.open(io.BytesIO(page_image(text)["buffer"]))
    if qr_bytes:
        qr = Image.open(io.BytesIO(base64.b64decode(qr_bytes))).convert("L")
        qr = qr.point(lambda value: 224 if value < 128 else 255).resize((900, 900), Image.Resampling.NEAREST)
        paper.paste(qr.convert("RGB"), (150, 620))
    output = io.BytesIO(); paper.save(output, format="PNG")
    page.evaluate("""async url => {
        const image = new Image(); image.src = url; await image.decode();
        if (!window.__syntheticCameraFrame) {
            const frame = document.createElement('canvas'); frame.width = 1200; frame.height = 1600;
            window.__syntheticCameraFrame = frame;
            window.__cameraTracks = [];
            navigator.mediaDevices.getUserMedia = async () => {
                const stream = frame.captureStream(15);
                window.__cameraTracks.push(...stream.getTracks());
                return stream;
            };
            navigator.mediaDevices.enumerateDevices = async () => [];
            // A camera keeps producing frames even while the paper is still.
            setInterval(() => {
                if (window.__syntheticPaper) frame.getContext('2d').drawImage(window.__syntheticPaper, 0, 0);
            }, 100);
        }
        window.__syntheticPaper = image;
        const frame = window.__syntheticCameraFrame;
        frame.getContext('2d').drawImage(image, 0, 0);
    }""", "data:image/png;base64," + base64.b64encode(output.getvalue()).decode())


def persistent_state(page):
    return page.evaluate("""async () => ({
        local: {...localStorage}, session: {...sessionStorage},
        databases: (await indexedDB.databases()).map(db => db.name).sort(),
        cache: (await Promise.all((await caches.keys()).map(async name =>
            (await (await caches.open(name)).keys()).map(request => request.url)))).flat().sort()
    })""")


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
@pytest.mark.parametrize("offline", [False, True], ids=["network-guard", "airplane-mode"])
def test_guided_pages_find_changed_word_and_clear_without_persistence(browser, sealed_text, path, offline, tmp_path):
    context = browser.new_context(service_workers="allow", viewport={"width": 430, "height": 932})
    try:
        base_url = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        guard = OfflineNetworkGuard(context, base_url)
        context.route("**/api/keys/default", lambda route: route.fulfill(status=200, json={"public_key": PUBLIC_KEY}))
        page = context.new_page(); downloads = []
        page.on("download", lambda download: downloads.append(download))
        page.goto(base_url + path, wait_until="networkidle")
        wait_for_offline_resources(page, photo=True)
        if path != "/":
            page.locator("#publicKeyFileInput").set_input_files({
                "name": "issuer-public.txt", "mimeType": "text/plain", "buffer": PUBLIC_KEY.encode(),
            })
        prepare_reader(page)
        page.wait_for_load_state("networkidle")
        baseline = persistent_state(page)
        guard.check_instrumentation(page); guard.block(offline=offline)
        # Page 1 is unchanged. Page 2 carries its original valid seal but an altered word.
        camera_paper(page, TEXT, sealed_text[0]["qr"])
        page.get_by_role("button", name="Check document", exact=True).click()
        expect(page.locator(".collection-progress, .ar-collection-progress, #statusText").filter(has_text="1 of 2 pages").first).to_be_visible(timeout=30000)
        camera_paper(page, TEXT.replace("Friday", "Monday"), sealed_text[1]["qr"])
        review = page.get_by_role("region", name="Review Page 2 of 2", exact=True)
        expect(review).to_be_visible(timeout=60000)
        expect(review.locator(".photo-differences")).to_contain_text("Friday")
        expect(review.locator(".photo-differences")).to_contain_text("Monday")
        expect(review.get_by_role("button", name="Different or extra text: Monday", exact=True)).to_be_visible()
        expect(review.get_by_role("img", name="Magnified photo difference").first).to_be_visible()
        expect(page.get_by_role("button", name=re.compile("Page 1 of 2.*Recognized text matches"))).to_be_visible()
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        assert page.locator("input[capture]").count() == 0
        assert persistent_state(page) == baseline
        page.screenshot(path=str(tmp_path / "page-2-difference.png"), full_page=True)

        # A retake stays in QRed's camera and replaces the old image and verdict.
        camera_paper(page, TEXT, sealed_text[1]["qr"])
        review.get_by_role("button", name="Retake this page", exact=True).click()
        dialog = page.get_by_role("dialog")
        expect(dialog.get_by_role("button", name="Use this view")).to_be_enabled()
        dialog.get_by_role("button", name="Use this view").click()
        expect(review.locator(".photo-summary")).to_have_text("Recognized text matches the signed text", timeout=60000)
        expect(review.locator(".photo-differences")).not_to_contain_text("Monday")

        # A deletion and an unreadable page must never become a matching result.
        for text, expected in [(TEXT.replace("Payment due Friday", ""), "Differences found"), ("", "No text could be read")]:
            camera_paper(page, text, None)
            review.get_by_role("button", name="Retake this page", exact=True).click()
            page.get_by_role("dialog").get_by_role("button", name="Use this view").click()
            expect(review.locator(".photo-summary")).to_contain_text(expected, timeout=60000)

        page.get_by_role("button", name="Finish & clear", exact=True).click()
        expect(page.locator(".photo-stage img")).to_have_count(0)
        expect(page.locator(".page-check-list button")).to_have_count(0)
        expect(page.locator(".verification-result")).to_have_count(0)
        assert "Monday" not in page.locator("body").inner_text()
        assert page.evaluate("window.__cameraTracks.every(track => track.readyState === 'ended')")
        assert downloads == []
        assert persistent_state(page) == baseline
        guard.assert_quiet()
    except Exception:
        if 'page' in locals() and not page.is_closed():
            page.screenshot(path=str(tmp_path / "verification-failure.png"), full_page=True)
        raise
    finally:
        context.close()


def test_missing_ocr_resource_stops_before_camera_and_retries(browser):
    context = browser.new_context(service_workers="block")
    try:
        page = context.new_page()
        base_url = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        context.route("**/ocr/v1/eng.traineddata.gz", lambda route: route.fulfill(status=404, body="Unavailable"))
        page.goto(base_url, wait_until="networkidle")
        page.evaluate("() => { window.__cameraRequests = 0; navigator.mediaDevices.getUserMedia = async () => { window.__cameraRequests++; throw Error('No test camera'); }; }")
        page.get_by_role("button", name="Check document", exact=True).click()
        expect(page.get_by_role("alert").filter(has_text="could not load")).to_be_visible(timeout=20000)
        assert page.evaluate("window.__cameraRequests") == 0
        context.unroute("**/ocr/v1/eng.traineddata.gz")
        page.get_by_role("button", name="Retry text recognition", exact=True).click()
        expect(page.get_by_role("button", name="Offline text checking ready", include_hidden=True)).to_have_count(1, timeout=60000)
    finally:
        context.close()
