"""Synthetic image/blank pages: real browser sealing, printed QR recovery,
reconstruction on both verifier routes, and offline visual comparison.
No uploaded or personal document is decoded by these tests.
"""
import base64
import io
import os
import subprocess

import pytest
from PIL import Image, ImageDraw
from playwright.sync_api import expect
from browser_helpers import OfflineNetworkGuard, stamp_and_save, wait_for_offline_resources
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

PUBLIC_KEY = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q="
PRIVATE_KEY = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes="


def synthetic_page(blank=False):
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=(612, 792))
    if not blank:
        image = Image.new("RGB", (600, 760), "white")
        draw = ImageDraw.Draw(image)
        for x in range(40, 560):
            shade = round(230 * (x - 40) / 520)
            draw.line((x, 70, x, 350), fill=(shade, shade, shade), width=1)
        draw.ellipse((100, 410, 280, 600), fill="black")
        draw.polygon([(360, 410), (540, 600), (340, 600)], fill=(120, 120, 120))
        pdf.drawImage(ImageReader(image), 30, 40, 552, 712)
    pdf.showPage()
    pdf.save()
    return buffer.getvalue()


def seal(page, pdf_bytes, destination):
    _, result = stamp_and_save(page, {
        "name": "synthetic-page.pdf", "mimeType": "application/pdf", "buffer": pdf_bytes,
    }, destination)
    return result


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
def test_load_pdf_seals_on_both_verifiers_offline(browser, tmp_path, path):
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=(612, 792))
    for number in (1, 2):
        pdf.drawString(40, 720, f"PDF verification example - page {number} of 2")
        pdf.drawString(40, 690, "Account 123456 | Amount 50.00")
        pdf.showPage()
    pdf.save()
    source = {"name": "unsealed.pdf", "mimeType": "application/pdf", "buffer": buffer.getvalue()}
    context = browser.new_context(service_workers="allow", viewport={"width": 430, "height": 932})
    try:
        guard = OfflineNetworkGuard(context)
        page = context.new_page()
        page.add_init_script("window.__qredTestMode = true")
        base = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        page.goto(base + "/", wait_until="networkidle")
        wait_for_offline_resources(page)
        page.get_by_role("button", name="Open PDF stamping tool").click()
        page.get_by_label("Private Key", exact=True).fill(PRIVATE_KEY)
        expect(page.get_by_label("Page layout", exact=True)).to_have_value("automatic")
        stamped = tmp_path / "pdf-input-sealed.pdf"
        seal(page, buffer.getvalue(), stamped)
        expect(page.locator("#stamp-result")).not_to_contain_text("Used clear footers")
        page.goto(base + path, wait_until="networkidle")
        picker = page.get_by_label("Open PDF to verify", exact=True)
        status = page.locator(".pdf-seal-input [role=status]")
        picker.set_input_files(source)
        expect(status).to_contain_text("No readable seal on PDF page(s): 1, 2.", timeout=90000)
        picker.set_input_files(stamped)
        expect(status).to_have_text("Found 2 QRed seals across 2 of 2 PDF pages.", timeout=90000)
        page.get_by_label("Open issuer public key file", exact=True).set_input_files({
            "name": "public-key.txt", "mimeType": "text/plain", "buffer": PUBLIC_KEY.encode(),
        })
        results = page.locator(".verification-card .verification-result" if path == "/" else "#resultContent .verification-result")
        expect(results).to_have_count(2)
        for index in range(2):
            expect(results.nth(index)).to_contain_text("VALID", timeout=30000)
            expect(results.nth(index)).to_contain_text(f"PDF verification example - page {index + 1} of 2")
        wait_for_offline_resources(page, pdf=True)
        page.get_by_role("button", name="Clear collected seals" if path == "/" else "New Scan", exact=True).click()
        expect(status).to_have_count(0)
        guard.block()
        picker.set_input_files(stamped)
        expect(status).to_have_text("Found 2 QRed seals across 2 of 2 PDF pages.", timeout=90000)
        expect(results).to_have_count(2)
        for index in range(2):
            expect(results.nth(index)).to_contain_text("VALID", timeout=30000)
        progress = page.locator(".verification-card .collection-progress" if path == "/" else "#resultMeta .collection-progress")
        expect(progress).to_have_text("All 2 pages collected.")
        guard.assert_quiet()
        picker.set_input_files({"name": "broken.pdf", "mimeType": "application/pdf", "buffer": b"not a PDF"})
        expect(status).to_contain_text("Could not read PDF seals:", timeout=30000)
    finally:
        context.close()


@pytest.mark.parametrize("logo_location", ["letterhead", "center", "sidebar"])
def test_text_invoice_with_raster_logos_keeps_watermarks(page, tmp_path, logo_location):
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=(612, 792))
    logo = Image.new("RGB", (120, 60), (60, 90, 120))
    ImageDraw.Draw(logo).ellipse((35, 5, 85, 55), fill=(180, 210, 230))
    logo_box = {"letterhead": (246, 702, 120, 60), "center": (246, 346, 120, 100),
                "sidebar": (454, 150, 140, 470)}[logo_location]
    for number in (1, 2):
        pdf.drawImage(ImageReader(logo), *logo_box)
        pdf.setFont("Helvetica", 12)
        pdf.drawString(40, 650, f"Example invoice - page {number} of 2")
        pdf.drawString(40, 630, "Account: 123456 | Amount: 50.00")
        if number == 1:
            for row in range(12):
                pdf.drawString(40, 580 - row * 18, f"Item {row + 1}: service charge")
        pdf.drawString(40, 70, "Example Lodge | 100 Sample Road")
        pdf.showPage()
    pdf.save()
    page.add_init_script("window.__qredTestMode = true")
    page.goto(os.environ.get("QRED_BASE_URL", "http://localhost:3000") + "/", wait_until="networkidle")
    page.get_by_role("button", name="Open PDF stamping tool").click()
    page.get_by_label("Private Key", exact=True).fill(PRIVATE_KEY)
    expect(page.get_by_label("Page layout", exact=True)).to_have_value("automatic")
    stamped = tmp_path / "invoice-sealed.pdf"
    result = seal(page, buffer.getvalue(), stamped)
    assert result["total_seals"] == 1
    expect(page.locator("#stamp-result")).not_to_contain_text("Used clear footers")
    subprocess.run(["pdftoppm", "-png", "-r", "144", str(stamped), str(tmp_path / "invoice")], check=True, capture_output=True)
    for number in (2, 1):
        printed = tmp_path / f"invoice-{number}.png"
        with Image.open(printed) as image:
            assert image.size == (1224, 1584)  # Original letter size on both pages.
        page.get_by_label("Choose QR image", exact=True).set_input_files(printed)
        if number == 2:
            page.get_by_label("Open issuer public key file", exact=True).set_input_files({
                "name": "public-key.txt", "mimeType": "text/plain", "buffer": PUBLIC_KEY.encode(),
            })
            expect(page.get_by_role("heading", name="VALID", exact=True)).to_be_visible(timeout=30000)
    expect(page.locator(".verification-card .collection-progress")).to_have_text("All 2 pages collected.", timeout=30000)
    results = page.locator(".verification-card .verification-result")
    expect(results).to_have_count(2)
    for index in range(2):
        expect(results.nth(index)).to_contain_text(f"Example invoice - page {index + 1} of 2")


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
@pytest.mark.parametrize("blank", [False, True], ids=["image", "blank"])
def test_visual_reference_from_printed_seal_works_offline(browser, tmp_path, path, blank):
    context = browser.new_context(service_workers="allow", viewport={"width": 430, "height": 932})
    try:
        guard = OfflineNetworkGuard(context)
        page = context.new_page()
        page.add_init_script("window.__qredTestMode = true")
        base = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        page.goto(base + "/", wait_until="networkidle")
        wait_for_offline_resources(page)
        page.get_by_role("button", name="Open PDF stamping tool").click()
        page.get_by_label("Private Key", exact=True).fill(PRIVATE_KEY)
        expect(page.get_by_label("Page layout", exact=True)).to_have_value("automatic")
        stamped = tmp_path / "sealed.pdf"
        result = seal(page, synthetic_page(blank), stamped)
        assert result["total_seals"] == 1
        assert result["evidence"]["blank"] == blank
        assert result["evidence"]["text"] == ""
        expect(page.get_by_text("Used clear footers on page(s) 1", exact=False)).to_be_visible()
        # Each sealing run creates a fresh PDF worker. Wait for the real
        # offline cache to contain it; an earlier download alone isn't enough.
        wait_for_offline_resources(page, pdf=True)
        guard.block()
        again = seal(page, synthetic_page(blank), tmp_path / "offline-sealed.pdf")
        assert again["evidence"] == result["evidence"]
        guard.assert_quiet()
        guard.allow_resources()
        subprocess.run(["pdftoppm", "-png", "-r", "144", "-singlefile", str(stamped), str(tmp_path / "printed")], check=True, capture_output=True)
        printed = Image.open(tmp_path / "printed.png")
        assert printed.size == (1224, 2016)  # Letter plus a clear legal footer.
        footer = printed.crop((0, 1584, 1224, 2016))
        footer.save(tmp_path / "seal.png")
        page.goto(base + path, wait_until="networkidle")
        guard.block()
        if path == "/":
            page.get_by_label("Choose QR image", exact=True).set_input_files(tmp_path / "seal.png")
            page.get_by_label("Open issuer public key file", exact=True).set_input_files({
                "name": "public-key.txt", "mimeType": "text/plain", "buffer": PUBLIC_KEY.encode(),
            })
            expect(page.get_by_role("heading", name="VALID", exact=True)).to_be_visible()
        else:
            page.locator("#publicKeyFileInput").set_input_files({
                "name": "public-key.txt", "mimeType": "text/plain", "buffer": PUBLIC_KEY.encode(),
            })
            camera_image = "data:image/png;base64," + base64.b64encode((tmp_path / "seal.png").read_bytes()).decode()
            page.evaluate("""async url => {
                const image = new Image(); image.src = url; await image.decode();
                const frame = document.createElement('canvas'); frame.width = image.width; frame.height = image.height;
                frame.getContext('2d').drawImage(image, 0, 0);
                const stream = frame.captureStream(15);
                navigator.mediaDevices.getUserMedia = async () => stream;
                navigator.mediaDevices.enumerateDevices = async () => [];
                window.__syntheticCameraFrame = frame;
            }""", camera_image)
            page.get_by_role("button", name="Scan QR Code", exact=True).click()
            expect(page.locator("#resultStatus")).to_have_text("VALID", timeout=30000)
        reference = page.get_by_role("region", name="Signed page reference", exact=True)
        expect(reference).to_be_visible()
        expect(page.get_by_role("button", name="Load text recognition", exact=True)).to_have_count(0)
        if blank:
            expect(reference).to_contain_text("signer recorded this page as blank")
        else:
            thumbnail = reference.get_by_role("img", name="Signed grayscale visual reference", exact=True)
            expect(thumbnail).to_be_visible()
            values = thumbnail.evaluate("el => Array.from(el.getContext('2d').getImageData(0,0,el.width,el.height).data)")
            assert min(values[::4]) == 0 and max(values[::4]) == 255
        reference.get_by_label("Choose visual comparison photo", exact=True).set_input_files(tmp_path / "printed.png")
        photo = reference.get_by_role("img", name="Page photo beside the signed visual reference")
        # The earlier QR-only scan is 432 px tall; wait for the user's full-page
        # replacement to finish decoding rather than observing the first image.
        # Under CI load PNG decoding/re-encoding can exceed Playwright's
        # default five-second assertion timeout. The exact full-page pixels
        # still have to be present; accepting the QR crop is not sufficient.
        expect(photo).to_have_js_property("naturalWidth", 1224, timeout=30000)
        expect(photo).to_have_js_property("naturalHeight", 2016, timeout=30000)
        guard.assert_quiet()
        if not blank and path == "/":
            page.screenshot(path=str(tmp_path / "visual-reference-mobile.png"), full_page=True)
    finally:
        context.close()
