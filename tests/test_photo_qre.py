"""Synthetic QRE page -> real photo worker -> signature -> independent OCR.

No decoder/OCR responses are mocked, no private documents are used, and no
physical print/phone reliability claim follows from these rendered fixtures.
"""
import hashlib
import json
import os
import subprocess
from pathlib import Path

import pytest
from PIL import Image
from playwright.sync_api import expect

from browser_helpers import (OfflineNetworkGuard, prepare_text_for_offline,
                             show_file_inputs, show_seal_details,
                             wait_for_offline_resources)

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def qre_photos(tmp_path_factory):
    directory = tmp_path_factory.mktemp("synthetic-qre-photos")
    source = (ROOT / "tests/fixtures/generate_qre_photo.mjs").read_text()
    result = subprocess.run(["node", "--input-type=module", "-e", source, str(directory)],
                            cwd=ROOT / "frontend", capture_output=True, text=True,
                            timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    manifest = json.loads((directory / "manifest.json").read_text())
    for variant in manifest["variants"].values():
        path = directory / variant["filename"]
        with Image.open(path) as image:
            assert image.size == (manifest["width"], manifest["height"])
            assert hashlib.sha256(image.convert("RGBA").tobytes()).hexdigest() == variant["rgbaSha256"]
        variant["path"] = path
    return manifest


# Observe messages sent to real workers. Forward the exact request and transfer
# list without replacing any worker, response, pixels, or recognition result.
# Hash copies before postMessage transfers ownership of the scanner's buffer.
OBSERVE_WORKER_INPUTS = """() => {
  const digest = async bytes => Array.from(new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
  window.__qrePhotoRequests = [];
  window.__qreOcrInputs = [];
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function(message, ...rest) {
    if (message?.image?.data && message.returnPayload && !message.live && !message.prepareReading) {
      const entry = {width:message.image.width,height:message.image.height};
      window.__qrePhotoRequests.push(entry);
      digest(message.image.data.slice()).then(hash => { entry.hash = hash; });
      this.addEventListener('message', event => { entry.action = event.data.action; }, {once:true});
    }
    if (message?.action === 'recognize' && message.payload?.image) {
      const entry = {}; window.__qreOcrInputs.push(entry);
      const bytes = message.payload.image.slice();
      createImageBitmap(new Blob([bytes])).then(async bitmap => {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d'); context.drawImage(bitmap,0,0); bitmap.close();
        entry.width = canvas.width; entry.height = canvas.height;
        entry.hash = await digest(context.getImageData(0,0,canvas.width,canvas.height).data);
        canvas.width = canvas.height = 0;
      }).catch(error => { entry.error = String(error); });
    }
    return Reflect.apply(post, this, [message, ...rest]);
  };
}"""


def storage_snapshot(page):
    return page.evaluate("""async () => ({
      local:{...localStorage}, session:{...sessionStorage},
      databases:(await indexedDB.databases()).map(db => db.name).sort(),
      caches:(await Promise.all((await caches.keys()).map(async name =>
        (await (await caches.open(name)).keys()).map(request => request.url)))).flat().sort()
    })""")


@pytest.mark.parametrize("variant,offline", [
    ("unchanged", False),
    ("changed-amount", True),
    ("deleted-line", True),
    ("added-text", True),
    ("four-missing", True),
])
def test_qre_image_upload_authenticates_then_checks_original_pixels(browser, qre_photos, variant, offline, tmp_path):
    """A valid seal does not turn altered surrounding text into a match."""
    fixture = qre_photos["variants"][variant]
    context = browser.new_context(service_workers="allow", viewport={"width": 430, "height": 932})
    try:
        base = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        guard = OfflineNetworkGuard(context, base)
        context.route("**/api/keys/default", lambda route: route.fulfill(json={"public_key": qre_photos["publicKey"]}))
        context.add_init_script("(" + OBSERVE_WORKER_INPUTS + ")()")
        page = context.new_page()
        downloads = []
        page.on("download", lambda download: downloads.append(download))
        page.goto(base, wait_until="networkidle")
        wait_for_offline_resources(page, photo=True)
        prepare_text_for_offline(page)
        page.wait_for_function("""async () =>
          Boolean(await caches.match('/ocr/v1/eng.traineddata.gz')) &&
          Boolean(await caches.match('/ocr/v1/legacy/eng.traineddata.gz'))
        """, timeout=10000)
        baseline = storage_snapshot(page)
        guard.check_instrumentation(page)
        guard.block(offline=offline)

        # Only image bytes enter the app, never fixture wording or QR coordinates.
        show_file_inputs(page)
        page.locator("#qr-image").set_input_files(fixture["path"])
        review = page.get_by_role("region", name="Review Page 1 of 1", exact=True)
        expect(review).to_be_visible(timeout=30000)
        expect(review.get_by_role("heading", name="Page 1 of 1 · Seal authenticated", exact=True)).to_be_visible()

        # Verify the cryptographic result independently of the OCR verdict.
        show_seal_details(page)
        seal = page.locator(".verification-result")
        expect(seal).to_have_count(1)
        expect(seal.get_by_role("heading", name="Seal authenticated", exact=True)).to_be_visible()
        expect(seal.locator("pre")).to_have_text(qre_photos["text"])
        differences = review.locator(".photo-differences")
        if variant in ("unchanged", "four-missing"):
            expect(review.locator(".photo-summary")).to_have_text("Recognized text matches the signed text", timeout=60000)
            expect(differences).to_have_text("")
        else:
            expect(review.locator(".photo-summary")).to_contain_text("Differences found", timeout=60000)
            if variant == "changed-amount":
                expect(differences).to_contain_text("123.45")
                expect(differences).to_contain_text("923.45")
            elif variant == "deleted-line":
                expect(differences).to_contain_text("Payment due Friday")
                expect(differences).to_contain_text("not read")
            else:
                expect(differences).to_contain_text("Paid")
        expect(page.locator(".page-check-status.queued, .page-check-status.reading")).to_have_count(0)

        # The actual manual-photo request found every expected QRE shard.
        page.wait_for_function("window.__qrePhotoRequests[0]?.hash && window.__qreOcrInputs[0]?.hash")
        observed = page.evaluate("({photo:window.__qrePhotoRequests,ocr:window.__qreOcrInputs})")
        assert len(observed["photo"]) == 1
        photo = observed["photo"][0]
        assert photo["action"]["status"] == "found-multiple"
        expected = [seal for index, seal in enumerate(qre_photos["seals"]) if index not in fixture["missing"]]
        assert set(photo["action"]["texts"]) == set(expected)
        # The first whole-page OCR request receives the unfiltered original,
        # not the contrast-normalized QRE crop used only to recover signatures.
        for reading in (photo, observed["ocr"][0]):
            assert reading["width"] == qre_photos["width"]
            assert reading["height"] == qre_photos["height"]
            assert reading["hash"] == fixture["rgbaSha256"]
        displayed = review.get_by_role("img", name="Page photo being compared with signed text", exact=True)
        expect(displayed).to_be_visible()
        shown_hash = displayed.evaluate("""async image => {
          await image.decode(); const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d'); context.drawImage(image,0,0);
          const data = context.getImageData(0,0,canvas.width,canvas.height).data;
          return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),
            x => x.toString(16).padStart(2,'0')).join('');
        }""")
        assert shown_hash == fixture["rgbaSha256"]
        assert storage_snapshot(page) == baseline
        page.screenshot(path=str(tmp_path / (variant + ".png")), full_page=True)

        page.get_by_role("button", name="Finish & clear", exact=True).click()
        expect(page.locator(".photo-stage img, .page-check-list button, .verification-result")).to_have_count(0)
        assert "923.45" not in page.locator("body").inner_text()
        assert storage_snapshot(page) == baseline
        assert downloads == []
        guard.assert_quiet()
    except Exception:
        if "page" in locals() and not page.is_closed():
            page.screenshot(path=str(tmp_path / (variant + "-failure.png")), full_page=True)
        raise
    finally:
        context.close()
