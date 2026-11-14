"""Real OCR, signed QR payloads, image highlights, and offline privacy.

All fixtures are synthetic. No personal document or uploaded QR is used.
"""
import base64
import io
import json
import math
import os
import re
import subprocess
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from playwright.sync_api import expect
from browser_helpers import OfflineNetworkGuard, show_file_inputs, wait_for_offline_resources, NATIVE_PHOTO_CAMERA_SCRIPT

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_KEY = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q="
TEXT = "Invoice 1042\nAccount 123456\nApproved total 123.45\nPayment due Friday"


def page_image(text, *, scale=1):
    image = Image.new("RGB", (1200 * scale, 1600 * scale), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype("DejaVuSans.ttf", 40 * scale)
    for index, line in enumerate(text.splitlines()):
        draw.text((100 * scale, (160 + index * 100) * scale), line, font=font, fill="black")
    output = io.BytesIO()
    image.save(output, format="PNG")
    return {"name": "synthetic-page.png", "mimeType": "image/png", "buffer": output.getvalue()}


def signed_pages(text, count):
    source = """
      import { createServer } from 'vite';
      import { PNG } from 'pngjs';
      const server = await createServer({ logLevel: 'error', server: { middlewareMode: true } });
      const { createQRedSeals } = await server.ssrLoadModule('/src/qredSealer.js');
      const { createQRedQrSymbol } = await server.ssrLoadModule('/src/qredQr.js');
      let input = ''; for await (const chunk of process.stdin) input += chunk;
      const { content, pageCount } = JSON.parse(input), pages = [];
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const sealed = await createQRedSeals({ content, timestamp: '2026-11-02T12:00:00Z',
        pageContext: { pageNumber, pageCount, documentRoot: 'ab'.repeat(32) },
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
    result = subprocess.run(["node", "--input-type=module", "-e", source], input=json.dumps({"content": text, "pageCount": count}),
                            cwd=ROOT / "frontend", text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


@pytest.fixture(scope="module")
def sealed_text():
    return signed_pages(TEXT, 2)


@pytest.fixture(scope="module")
def dated_form_photos():
    signed = "Service record\nStart 03-14-27\nAmount 29.50\nStatus Approved"
    qr = Image.open(io.BytesIO(base64.b64decode(signed_pages(signed, 1)[0]["qr"]))).convert("L")
    watermark = qr.point(lambda ink: 224 if ink == 0 else 255).resize((1360, 1780), Image.Resampling.NEAREST)
    font = ImageFont.truetype("DejaVuSans.ttf", 48)
    photos = {}
    for kind, date, amount, status in [("original", "03-14-27", "29.50", "Approved"),
                                       ("changed", "03-14-29", "29.50", "Approved twice"),
                                       ("erased", "03-14-2", "", "Approved")]:
        paper = Image.new("L", (1600, 2100), "white")
        paper.paste(watermark, (120, 175))
        draw = ImageDraw.Draw(paper)
        draw.text((160, 215), "Service record", font=font, fill=32)
        for y, label, value in [(400, "Start", date), (545, "Amount", amount), (695, "Status", status)]:
            draw.text((160, y), label, font=font, fill=32)
            draw.text((480, y), value, font=font, fill=32)
        paper.paste(qr.resize((710, 710), Image.Resampling.NEAREST), (720, 1120))
        frame = Image.new("L", (1920, 2560), 55)
        for x in range(paper.width):
            bend = round(24 * math.sin(math.pi * x / paper.width))
            frame.paste(paper.crop((x, 0, x + 1, paper.height)), (160 + x, 200 + bend))
        image = io.BytesIO()
        frame.save(image, format="JPEG", quality=91)
        photos[kind] = {"name": f"{kind}.jpg", "mimeType": "image/jpeg", "buffer": image.getvalue()}
    return photos


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
def test_changed_and_erased_digits_on_a_curled_dated_form(browser, dated_form_photos, path):
    base = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
    context = browser.new_context(service_workers="allow")
    try:
        guard = OfflineNetworkGuard(context, base)
        context.route("**/api/keys/default", lambda route: route.fulfill(json={"public_key": PUBLIC_KEY}))
        page = context.new_page()
        for kind, photo in dated_form_photos.items():
            guard.allow_resources()
            page.goto(base + path, wait_until="networkidle")
            wait_for_offline_resources(page, photo=True)
            if path != "/":
                page.locator("#publicKeyFileInput").set_input_files({
                    "name": "issuer.txt", "mimeType": "text/plain", "buffer": PUBLIC_KEY.encode()})
            prepare_reader(page)
            guard.block()
            show_file_inputs(page)
            page.locator("#qr-image" if path == "/" else "#pagePhotoInput").set_input_files(photo)
            review = page.get_by_role("region", name="Review Page 1 of 1", exact=True)
            expect(review.get_by_role("heading", name=re.compile("Seal authenticated"))).to_be_visible(timeout=30000)
            expect(page.locator(".page-check-status.queued, .page-check-status.reading")).to_have_count(0, timeout=60000)
            if kind == "original":
                review.get_by_label("Show matching words too").check()
                expect(review.get_by_role("button", name="Matching text: 03-14-27", exact=True)).to_have_count(1)
            else:
                cards = review_differences(review)
                assert any("03-14-27" in card for card in cards)
                printed_date = "03-14-29" if kind == "changed" else "03-14-2"
                assert sum(bool(re.search(r"Photo reading: [^\n]*\b" + printed_date + r"\b", card)) for card in cards) == 1
                assert any(("twice" if kind == "changed" else "29.50") in card for card in cards)
                expect(review.locator(".photo-summary")).to_contain_text("Differences found")
            guard.assert_quiet()
    finally:
        context.close()


def review_differences(review):
    """Walk the same difference cards the verifier sees, including the last one."""
    cards = []
    current = review.locator(".photo-differences > ol > li")
    if not current.count():
        return cards
    forward = review.get_by_role("button", name="Next difference", exact=True)
    while True:
        cards.append(current.inner_text())
        if not forward.count() or forward.is_disabled():
            return cards
        forward.click()


def prepare_reader(page):
    page.get_by_text("Prepare for offline checking", exact=True).click()
    page.get_by_role("button", name="Prepare offline checking", exact=True).click()
    expect(page.get_by_role("button", name="Offline text checking ready", exact=True)).to_be_visible(timeout=60000)


@pytest.mark.parametrize("shadowed", [False, True], ids=["clear", "warm-watermark"])
def test_scaled_table_recovers_numeric_columns_and_keeps_swapped_amounts_visible(browser, shadowed):
    """Real OCR of a print-scaled table, with authenticated line locations."""
    draw = """async ({swapped = false, qr = null, shadowed = false}) => {
      const canvas = document.createElement('canvas'); canvas.width = 1400; canvas.height = 1800;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#333'; ctx.fillRect(0,0,1400,1800);
      ctx.fillStyle = 'white'; ctx.fillRect(100,100,1200,1600);
      const content = [], boxes = [];
      function line(parts, y, printed = parts) {
        ctx.font = '32px Arial'; ctx.fillStyle = 'black';
        const xs = parts.length === 1 ? [100] : [100,600,900];
        const right = xs.at(-1) + ctx.measureText(parts.at(-1)).width;
        boxes.push({x:xs[0]/1200,y:(y-30)/1600,width:(right-xs[0])/1200,height:40/1600});
        content.push(parts.join(' '));
        ctx.save(); ctx.translate(136,140); ctx.scale(.94,.94);
        printed.forEach((part,i) => ctx.fillText(part,xs[i],y)); ctx.restore();
      }
      line(['Invoice account reference'],130);
      const names = ['Room','Breakfast','Dinner','Parking','Tax','Service','Credit','Balance'];
      names.forEach((name,row) => {
        const parts = [name,(100+row*11)+'.50','0.00'];
        line(parts,250+row*85,swapped && row < 2 ? [name,(row === 0 ? '111' : '100')+'.50','0.00'] : parts);
      });
      line(['Payment due Friday'],1100); line(['Document reference confirmed'],1450);
      if (qr) {
        const image = new Image(); image.src = 'data:image/png;base64,' + qr; await image.decode();
        ctx.save(); ctx.translate(136,140); ctx.scale(.94,.94);
        if (shadowed) {
          ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = .22;
          ctx.imageSmoothingEnabled = false; ctx.drawImage(image,70,70,1060,1460);
          ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
        }
        ctx.imageSmoothingEnabled = false; ctx.drawImage(image,750,1000,400,400); ctx.restore();
      }
      if (shadowed) {
        const pixels = ctx.getImageData(0,0,1400,1800);
        for (let y=0;y<1800;y++) for (let x=0;x<1400;x++) {
          const offset=(y*1400+x)*4, light=.9-.3*y/1800;
          for (let c=0;c<3;c++) pixels.data[offset+c] *= light * [1,.95,.85][c];
        }
        ctx.putImageData(pixels,0,0);
      }
      return {evidence:{text:content.join('\\n'),width:1200,height:1600,layout:{mode:3,lines:boxes}},
        png:canvas.toDataURL('image/png').split(',')[1]};
    }"""
    context = browser.new_context(service_workers="allow", viewport={"width": 430, "height": 932})
    try:
        context.route("**/api/keys/default", lambda route: route.fulfill(json={"public_key": PUBLIC_KEY}))
        page = context.new_page()
        base = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        page.goto(base, wait_until="networkidle")
        evidence = page.evaluate(draw, {})["evidence"]
        source = """
          import { createServer } from 'vite'; import { PNG } from 'pngjs';
          const server = await createServer({logLevel:'error',server:{middlewareMode:true}});
          const {encodePageEvidence} = await server.ssrLoadModule('/src/pageEvidence.js');
          const {createQRedSeals} = await server.ssrLoadModule('/src/qredSealer.js');
          const {createQRedQrSymbol} = await server.ssrLoadModule('/src/qredQr.js');
          let input = ''; for await (const chunk of process.stdin) input += chunk;
          const evidence = JSON.parse(input);
          const sealed = await createQRedSeals({content:evidence.text,pageEvidence:encodePageEvidence(evidence),
            timestamp:'2026-11-02T12:00:00Z',pageContext:{pageNumber:1,pageCount:1,documentRoot:'cd'.repeat(32)},
            privateKey:'txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=',
            publicKey:'eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q='});
          if (sealed.seals.length !== 1) throw new Error('Test table should fit in one seal');
          const {modules} = createQRedQrSymbol(sealed.seals[0]), size = (modules.size + 8) * 4;
          const image = new PNG({width:size,height:size}); image.data.fill(255);
          for (let y=0; y<size; y++) for (let x=0; x<size; x++) {
            const r=Math.floor(y/4)-4,c=Math.floor(x/4)-4;
            if(r>=0 && c>=0 && r<modules.size && c<modules.size && modules.get(r,c)) {
              const i=(y*size+x)*4; image.data[i]=image.data[i+1]=image.data[i+2]=0;
            }
          }
          console.log(PNG.sync.write(image).toString('base64')); await server.close();
        """
        qr = subprocess.run(["node", "--input-type=module", "-e", source], input=json.dumps(evidence),
                            cwd=ROOT / "frontend", text=True, capture_output=True, check=True).stdout.strip()
        for swapped in [False, True]:
            page.goto(base, wait_until="networkidle")
            photo = page.evaluate(draw, {"swapped": swapped, "qr": qr, "shadowed": shadowed})
            page.get_by_text("Open an existing PDF or image", exact=True).click()
            page.locator("#qr-image").set_input_files({"name": "table.png", "mimeType": "image/png",
                                                       "buffer": base64.b64decode(photo["png"])})
            review = page.get_by_role("region", name="Review Page 1 of 1", exact=True)
            expect(review).to_be_visible(timeout=30000)
            expect(page.locator(".page-check-status.queued, .page-check-status.reading")).to_have_count(0, timeout=60000)
            if swapped:
                cards = review_differences(review)
                assert any("100.50" in card for card in cards)
                assert any("111.50" in card for card in cards)
                expect(review.locator(".photo-summary")).to_contain_text("Differences found")
            else:
                differences = review.locator(".photo-differences").inner_text()
                assert differences == "", differences + "\n" + review.locator(".photo-legend").inner_text()
                expect(review.locator(".photo-summary")).to_have_text(
                    re.compile("Recognized text matches the signed text|Some readings need review"))
    finally:
        context.close()


def camera_paper(page, text, qr_bytes, *, border=True, blur=0):
    # Render text and QR geometry directly at the native still dimensions.
    # Downsampling this source produces the video preview, never the reverse.
    paper = Image.open(io.BytesIO(page_image(text, scale=2)["buffer"]))
    if qr_bytes:
        qr = Image.open(io.BytesIO(base64.b64decode(qr_bytes))).convert("L")
        qr = qr.point(lambda value: 224 if value < 128 else 255).resize((1800, 1800), Image.Resampling.NEAREST)
        paper.paste(qr.convert("RGB"), (300, 1240))
    if border:
        frame = Image.new("RGB", (2880, 3840), (55, 55, 55))
        frame.paste(paper, (240, 320))
        paper = frame
    if blur:
        paper = paper.filter(ImageFilter.GaussianBlur(blur * 2))
    output = io.BytesIO(); paper.save(output, format="PNG")
    page.evaluate("""async url => {
        const image = new Image(); image.src = url; await image.decode();
        if (!window.__syntheticCameraFrame) {
            const frame = document.createElement('canvas');
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
                if (window.__syntheticPaper) frame.getContext('2d').drawImage(window.__syntheticPaper, 0, 0, frame.width, frame.height);
            }, 100);
        }
        window.__syntheticNativePhoto = image;
        window.__syntheticPaper = image;
        const frame = window.__syntheticCameraFrame;
        frame.width = image.naturalWidth / 2; frame.height = image.naturalHeight / 2;
        frame.getContext('2d').drawImage(image, 0, 0, frame.width, frame.height);
    }""", "data:image/png;base64," + base64.b64encode(output.getvalue()).decode())
    page.evaluate(NATIVE_PHOTO_CAMERA_SCRIPT)
    return {"name": "synthetic-native-photo.png", "mimeType": "image/png", "buffer": output.getvalue()}


def persistent_state(page):
    return page.evaluate("""async () => ({
        local: {...localStorage}, session: {...sessionStorage},
        databases: (await indexedDB.databases()).map(db => db.name).sort(),
        cache: (await Promise.all((await caches.keys()).map(async name =>
            (await (await caches.open(name)).keys()).map(request => request.url)))).flat().sort()
    })""")


def test_loading_all_photos_while_camera_is_open_finishes_collection_and_checks_text(browser, sealed_text):
    context = browser.new_context(service_workers="allow", viewport={"width": 393, "height": 873})
    try:
        context.route("**/api/keys/default", lambda route: route.fulfill(json={"public_key": PUBLIC_KEY}))
        page = context.new_page()
        page.goto(os.environ.get("QRED_BASE_URL", "http://localhost:3000"), wait_until="networkidle")
        prepare_reader(page)
        camera_paper(page, "", None, border=False)
        page.get_by_role("button", name="Check document", exact=True).click()
        page.wait_for_function("document.querySelector('video')?.readyState >= 2")
        page.get_by_text("Open an existing PDF or image", exact=True).click()
        for index, text in enumerate([TEXT, TEXT.replace("Friday", "Monday")]):
            paper = Image.open(io.BytesIO(page_image(text)["buffer"]))
            qr = Image.open(io.BytesIO(base64.b64decode(sealed_text[index]["qr"]))).convert("L")
            qr = qr.point(lambda value: 224 if value < 128 else 255).resize((900, 900), Image.Resampling.NEAREST)
            paper.paste(qr.convert("RGB"), (150, 620))
            photo = Image.new("RGB", (1440, 1920), (55, 55, 55)); photo.paste(paper, (120, 160))
            output = io.BytesIO(); photo.save(output, format="JPEG", quality=95)
            page.locator("#qr-image").set_input_files({"name": f"page-{index+1}.jpg", "mimeType": "image/jpeg", "buffer": output.getvalue()})
            expect(page.locator(".page-check-list button")).to_have_count(index + 1, timeout=30000)
        expect(page.locator("video")).to_have_count(0, timeout=10000)
        expect(page.get_by_role("region", name="Document check").get_by_text("All 2 pages collected.", exact=True)).to_be_visible()
        expect(page.get_by_text("Show the next page, or review the pages captured so far.", exact=True)).to_have_count(0)
        expect(page.get_by_role("region", name="Review Page 2 of 2").locator(".photo-differences")).to_contain_text("Monday", timeout=60000)
        assert page.evaluate("window.__cameraTracks.every(track => track.readyState === 'ended')")
        page.get_by_role("button", name="Finish & clear", exact=True).click()
        expect(page.locator(".photo-stage img")).to_have_count(0)
    finally:
        context.close()


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
        page.get_by_role("button", name=re.compile("Page 1 of 2.*Recognized text matches")).click()
        expect(page.get_by_role("region", name="Review Page 1 of 2", exact=True)).to_be_visible()
        page.get_by_role("button", name=re.compile("Page 2 of 2.*Differences found")).click()
        expect(review).to_be_visible()
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        assert page.locator("input[capture]").count() == 0
        assert persistent_state(page) == baseline
        page.screenshot(path=str(tmp_path / "page-2-difference.png"), full_page=True)

        # A different page, even with the same signed text, cannot replace page 2.
        # No visible border exercises the manual quality override on retakes.
        camera_paper(page, TEXT, sealed_text[0]["qr"], border=False)
        review.get_by_role("button", name="Retake this page", exact=True).click()
        page.get_by_role("dialog").get_by_role("button", name="Capture now").click()
        expect(page.get_by_role("dialog").get_by_role("alert")).to_contain_text("does not match Page 2", timeout=30000)
        expect(review.locator(".photo-differences")).to_contain_text("Monday")
        page.get_by_role("button", name="Cancel retake", exact=True).click()

        # A retake stays in QRed's camera and replaces the old image and verdict.
        camera_paper(page, TEXT, sealed_text[1]["qr"], border=False)
        review.get_by_role("button", name="Retake this page", exact=True).click()
        dialog = page.get_by_role("dialog")
        expect(dialog.get_by_role("button", name="Capture now")).to_be_enabled()
        dialog.get_by_role("button", name="Capture now").click()
        expect(review.locator(".photo-summary")).to_have_text("Recognized text matches the signed text", timeout=60000)
        expect(review.locator(".photo-differences")).not_to_contain_text("Monday")

        # A deletion and an unreadable page must never become a matching result.
        for text, expected in [(TEXT.replace("Payment due Friday", ""), "Differences found"), ("", "No text could be read")]:
            camera_paper(page, text, sealed_text[1]["qr"], border=False)
            review.get_by_role("button", name="Retake this page", exact=True).click()
            page.get_by_role("dialog").get_by_role("button", name="Capture now").click()
            expect(review.locator(".photo-summary")).to_contain_text(expected, timeout=60000)

        page.get_by_role("button", name="Finish & clear", exact=True).click()
        expect(page.locator(".photo-stage img")).to_have_count(0)
        expect(page.locator(".page-check-list button")).to_have_count(0)
        expect(page.locator(".verification-result")).to_have_count(0)
        assert "Monday" not in page.locator("body").inner_text()
        assert page.evaluate("window.__cameraTracks.every(track => track.readyState === 'ended')")
        expect(page.get_by_role("status").filter(has_text="Check cleared. Camera off.")).to_be_visible()
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

@pytest.mark.parametrize("layout", ["automatic", "legal-footer"])
def test_real_stamped_pages_separate_markings_and_detect_edits(browser, tmp_path, layout):
    """Use QRed's actual renderer: its pale background and navigation stamp matter."""
    from reportlab.pdfgen import canvas
    from browser_helpers import stamp_and_save, show_file_inputs

    source = io.BytesIO()
    pdf = canvas.Canvas(source, pagesize=(612, 792))
    for _ in range(2):
        pdf.setFont("Helvetica", 24)
        for index, line in enumerate(TEXT.splitlines()):
            pdf.drawString(60, 700 - index * 60, line)
        pdf.showPage()
    pdf.save()
    context = browser.new_context(service_workers="allow", viewport={"width": 390, "height": 844})
    page = context.new_page()
    try:
        context.route("**/api/keys/default", lambda route: route.fulfill(json={"public_key": PUBLIC_KEY}))
        base = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        page.goto(base, wait_until="networkidle")
        # This exact watermark pattern previously made global-threshold OCR
        # report background glyphs instead of the four unchanged text lines.
        # Fix Date only; camera, decoding and recognition timers still run.
        page.clock.set_fixed_time("2026-11-02T22:28:38.060Z")
        page.get_by_role("button", name="Open PDF stamping tool").click()
        page.get_by_role("button", name="Private key (offline)", exact=True).click()
        page.get_by_label("Private Key", exact=True).fill("txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=")
        page.get_by_label("Page layout", exact=True).select_option(layout)
        stamped, _ = stamp_and_save(page, {"name": "invoice.pdf", "mimeType": "application/pdf", "buffer": source.getvalue()}, tmp_path / "sealed.pdf")

        for variant in ["unchanged", "changed", "light addition"]:
            opened = stamped
            if variant != "unchanged":
                opened = tmp_path / (variant.replace(" ", "-") + ".pdf")
                mutation = """
                  import fs from 'node:fs';
                  import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
                  const [source, target, variant] = process.argv.slice(1);
                  const pdf = await PDFDocument.load(fs.readFileSync(source));
                  const page = pdf.getPage(1), offset = page.getHeight() - 792;
                  const font = await pdf.embedFont(StandardFonts.Helvetica);
                  if (variant === 'changed') {
                    const left = 60 + font.widthOfTextAtSize('Payment due ', 24);
                    page.drawRectangle({x:left-2,y:offset+510,width:105,height:38,color:rgb(1,1,1)});
                    page.drawText('Monday',{x:left,y:offset+520,size:24,font,color:rgb(0,0,0)});
                  }
                  const ink = variant === 'changed' ? 0 : .7;
                  page.drawText('Paid',{x:60,y:offset+430,size:24,font,color:rgb(ink,ink,ink)});
                  fs.writeFileSync(target,await pdf.save());
                """
                subprocess.run(["node", "--input-type=module", "-e", mutation, str(stamped), str(opened), variant],
                               cwd=ROOT / "frontend", check=True, capture_output=True)
            page.goto(base, wait_until="networkidle")
            show_file_inputs(page)
            page.get_by_label("Open PDF to verify", exact=True).set_input_files(opened)
            expect(page.locator(".page-check-list button")).to_have_count(2, timeout=90000)
            expect(page.locator(".page-check-status.queued, .page-check-status.reading")).to_have_count(0, timeout=60000)
            page.locator(".page-check-list button").nth(1).click()
            review = page.get_by_role("region", name="Review Page 2 of 2", exact=True)
            if variant == "unchanged":
                expect(review.locator(".photo-summary")).not_to_contain_text("No text")
                assert review.locator(".photo-differences").inner_text() == ""
                page.locator(".page-check-list button").nth(0).click()
                first = page.get_by_role("region", name="Review Page 1 of 2", exact=True)
                assert first.locator(".photo-differences").inner_text() == ""
                # OCR may skip the small caption altogether. The user-facing
                # requirement is no false document difference, whether stamp
                # readings need separate review or no stamp text was returned.
                expect(first.locator(".photo-summary")).to_have_text(
                    re.compile("Recognized text matches the signed text|Some readings need review"))
            elif variant == "changed":
                cards = review_differences(review)
                for wording in ["Friday", "Monday", "Paid"]:
                    assert any(wording in card for card in cards)
            else:
                # A contrast fallback must never turn an unreadable light addition
                # into an unqualified agreement. It needs explicit visual review.
                expect(review.locator(".photo-summary")).not_to_have_text("Recognized text matches the signed text")
            page.screenshot(path=str(tmp_path / (layout + "-" + variant.replace(" ", "-") + ".png")), full_page=True)
    finally:
        context.close()


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
def test_partial_page_check_has_next_page_guidance_and_focus(browser, sealed_text, path, tmp_path):
    context = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="allow")
    try:
        page = context.new_page()
        context.route("**/api/keys/default", lambda route: route.fulfill(json={"public_key": PUBLIC_KEY}))
        page.goto(os.environ.get("QRED_BASE_URL", "http://localhost:3000") + path, wait_until="networkidle")
        if path != "/":
            page.locator("#publicKeyFileInput").set_input_files({"name": "key.txt", "mimeType": "text/plain", "buffer": PUBLIC_KEY.encode()})
        expect(page.get_by_text("Camera photos stay on this device.", exact=False)).to_be_visible()
        camera_paper(page, TEXT.replace("Friday", "Monday"), sealed_text[1]["qr"])
        page.get_by_role("button", name="Check document", exact=True).click()
        expect(page.locator(".ar-collection-progress, #statusText").filter(has_text="Page 2 captured. Show page 1.")).to_be_visible(timeout=45000)
        if path == "/verify.htm":
            assert page.locator("#sealList").evaluate("e => e.scrollWidth <= e.clientWidth")
        page.get_by_role("button", name="Check this page now", exact=True).click()
        review = page.get_by_role("region", name="Review Page 2 of 2", exact=True)
        expect(review.locator(".photo-differences")).to_contain_text("Monday", timeout=60000)
        expect(review.get_by_role("heading", name=re.compile("Page 2"))).to_be_focused()
        overview = review.get_by_role("img", name="Page photo being compared with signed text").bounding_box()
        assert overview["y"] >= 0 and overview["y"] + overview["height"] < 844, overview
        crop = review.get_by_role("img", name="Magnified photo difference").first.bounding_box()
        assert crop["y"] >= overview["y"] + overview["height"]
        assert review.locator(".photo-differences > ol").evaluate("e => e.scrollHeight === e.clientHeight")
        expect(page.get_by_text("Other pages have not been checked.", exact=False)).to_be_visible()
        page.screenshot(path=str(tmp_path / "page-first.png"))
    finally:
        context.close()
