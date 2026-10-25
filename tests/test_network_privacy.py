"""Real browser workflows must stay local once their resources are cached.

Run with the production preview on QRED_BASE_URL (default localhost:3000).
The real service worker stays enabled. Only external HTTP/WebSocket attempts
are blocked; local blob URLs and service-worker cache reads remain available.
"""

import io
import os
import subprocess
from pathlib import Path

import pytest
from playwright.sync_api import expect
from browser_helpers import OfflineNetworkGuard, stamp_and_save, wait_for_offline_resources
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


def _pdf_bytes(text):
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=letter)
    for index, line in enumerate(text.splitlines()):
        pdf.drawString(50, 700 - index * 16, line)
    pdf.save()
    return buffer.getvalue()


def _stamp_and_save(page, directory, name, text):
    path, _ = stamp_and_save(page, {
        "name": name, "mimeType": "application/pdf", "buffer": _pdf_bytes(text),
    }, directory / name.replace(".pdf", ".qred-sealed.pdf"))
    return path


@pytest.mark.parametrize("offline", [False, True], ids=["connected-but-guarded", "airplane-mode"])
@pytest.mark.parametrize("layout", ["automatic", "legal-footer"])
def test_local_workflow_makes_no_network_requests(browser, tmp_path, offline, layout):
    context = browser.new_context(service_workers="allow", accept_downloads=True)
    try:
        base_url = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
        guard = OfflineNetworkGuard(context, base_url)
        page = context.new_page()
        page.add_init_script("window.__qredTestMode = true;")
        page.goto(base_url, wait_until="networkidle")
        wait_for_offline_resources(page)

        # Explicit online warm-up, using disposable data, loads the lazy
        # PDF module, worker and fonts through the actual stamping UI.
        page.get_by_role("button", name="Open PDF stamping tool").click()
        page.get_by_label("Page layout", exact=True).select_option(layout)
        page.get_by_role("button", name="Generate key pair", exact=True).click()
        expect(page.locator("#signing-key-status")).to_contain_text("Key pair generated.")
        _stamp_and_save(page, tmp_path, "public-warmup.pdf", "Non-sensitive resource warm-up")
        page.get_by_role("button", name="Close", exact=True).click()
        page.wait_for_load_state("networkidle")
        wait_for_offline_resources(page, pdf=True)
        guard.check_instrumentation(page)
        guard.block(offline=offline)
        assert page.evaluate("navigator.onLine") is (not offline)

        # Sensitive test data and fresh signing keys are introduced only
        # after the guard is active. No navigation or reload is needed.
        page.get_by_role("button", name="Open PDF stamping tool").click()
        page.get_by_role("button", name="Generate key pair", exact=True).click()
        expect(page.locator("#signing-key-status")).to_contain_text("Key pair generated.")
        private_key = page.get_by_label("Private Key", exact=True).input_value()
        page.wait_for_function("window.__qredPublicKeys && window.__qredPublicKeys.length === 43")
        public_key = page.evaluate("window.__qredPublicKeys")
        for kind, key in [("private", private_key), ("public", public_key)]:
            with page.expect_download() as saved:
                page.get_by_role("button", name=f"Save {kind} key", exact=True).click()
            path = tmp_path / saved.value.suggested_filename
            saved.value.save_as(path)
            assert path.read_text().strip() == key
        page.get_by_role("button", name="Close", exact=True).click()
        page.get_by_role("button", name="Open PDF stamping tool").click()
        page.get_by_label("Open private key file", exact=True).set_input_files(tmp_path / "qred-ed25519-private-key.txt")
        expect(page.locator("#signing-key-status")).to_contain_text("Private key opened. Matching public key derived.")
        expect(page.get_by_label("Private Key", exact=True)).to_have_value(private_key)
        expect(page.get_by_label("Public Key", exact=True)).to_have_count(0)
        page.wait_for_function("key => window.__qredPublicKeys === key", arg=public_key)
        expect(page.get_by_label("Issuer public key", exact=True)).to_have_count(0)

        text = "Private offline invoice NETWORK-1042. Approved total: $123.45."
        page.get_by_label("Page layout", exact=True).select_option(layout)
        sealed_path = _stamp_and_save(page, tmp_path, "private-invoice.pdf", "\n".join([text] * 5))
        # Check that compression was chosen automatically, then verify actual
        # saved-PDF pixels through the normal image-selection UI.
        assert page.evaluate("window.__lastSealResult.encoding") == "zlib"
        footer = tmp_path / "private-invoice-footer"
        area = [] if layout == "automatic" else ["-x", "0", "-y", "2200", "-W", "1700", "-H", "600"]
        subprocess.run(["pdftoppm", "-f", "1", "-singlefile", "-r", "200", *area,
                        "-png", str(sealed_path), str(footer)], check=True, capture_output=True)
        page.get_by_label("Choose QR image", exact=True).set_input_files(footer.with_suffix(".png"))
        page.get_by_label("Open issuer public key file", exact=True).set_input_files(tmp_path / "qred-ed25519-public-key.txt")
        expect(page.get_by_role("heading", name="VALID", exact=True)).to_be_visible(timeout=20000)
        expect(page.locator(".verification-result pre")).to_contain_text(text)

        # Also exercise file reading, image decoding and hidden-payload
        # recovery from real stamped-PDF pixels while networking is blocked.
        page.get_by_role("button", name="Clear collected seals", exact=True).click()
        fixture_key = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q="
        fixture = Path(__file__).parent / "fixtures" / "compact-qr" / "invoice-footer-300dpi.png"
        page.get_by_label("Choose QR image", exact=True).set_input_files(fixture)
        page.get_by_label("Open issuer public key file", exact=True).set_input_files({
            "name": "fixture-public-key.txt", "mimeType": "text/plain", "buffer": fixture_key.encode(),
        })
        expect(page.get_by_role("heading", name="VALID", exact=True)).to_be_visible(timeout=20000)
        expect(page.locator(".verification-result pre")).to_contain_text("Approved total: $123.45")
        page.get_by_label("Open issuer public key file", exact=True).set_input_files(tmp_path / "qred-ed25519-public-key.txt")
        expect(page.get_by_role("heading", name="INVALID", exact=True)).to_be_visible()

        # Flush pending request callbacks, including background SW fetches.
        page.wait_for_load_state("networkidle")
        guard.assert_quiet()
    finally:
        context.close()
