"""Opt-in exact digital-PDF experiment: generated, source-independent browser E2E.

Every document here is disposable synthetic data. The public fixture signing key
proves the protocol path, not issuer identity. No private invoice or reference PDF
is opened. Browser verification gets only the downloaded PDF and public key.
"""
import io
import os
import subprocess
from pathlib import Path

import pytest
from playwright.sync_api import expect
from reportlab.pdfgen import canvas

from browser_helpers import OfflineNetworkGuard, wait_for_offline_resources

BASE = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
PRIVATE_KEY = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes="
PUBLIC_KEY = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q"
ROOT = Path(__file__).resolve().parents[1]


def synthetic_pdf(pages=2):
    output = io.BytesIO()
    pdf = canvas.Canvas(output, pagesize=(612, 792), invariant=1)
    for number in range(1, pages + 1):
        # The compact central source leaves ample white space for the exact
        # protocol's sixteen stamps, without providing any placement hints.
        pdf.setFont("Helvetica", 12)
        pdf.drawString(220, 500, f"Synthetic page {number} of {pages}")
        pdf.drawString(220, 470, "Company Name: EXAMPLE")
        pdf.drawString(250, 410, "Amount: 50.00")
        pdf.setLineWidth(2)
        pdf.rect(250, 350, 50, 20, stroke=1, fill=0)
        pdf.showPage()
    pdf.save()
    return output.getvalue()


def open_experiment(page):
    page.goto(BASE + "/", wait_until="networkidle")
    expect(page.get_by_role("heading", name="Check a printed document", exact=True)).to_be_visible()
    expect(page.get_by_label("Open exact-mode PDF", exact=True)).to_have_count(0)
    page.get_by_role("button", name="Open experimental exact PDF tool", exact=True).click()
    expect(page.get_by_role("heading", name="Exact rendered appearance", exact=True)).to_be_visible()
    expect(page.get_by_test_id("exact-scope")).to_contain_text("unchanged PDF bytes")
    expect(page.get_by_test_id("exact-scope")).to_contain_text("does not verify prints or photos")
    expect(page.get_by_test_id("exact-scope")).to_contain_text("Native canvas rendering can differ")
    return page.locator(".exact-pdf-experiment")


def seal_and_download(page, target, *, pages=2):
    tool = page.locator(".exact-pdf-experiment")
    tool.get_by_label("Open exact-mode PDF", exact=True).set_input_files({
        "name": "synthetic-original.pdf", "mimeType": "application/pdf", "buffer": synthetic_pdf(pages),
    })
    tool.get_by_label("Exact-mode private key (for sealing only)", exact=True).fill(PRIVATE_KEY)
    expect(tool.get_by_label("Exact-mode public key", exact=True)).to_have_value(PUBLIC_KEY)
    with page.expect_download(timeout=120000) as saved:
        tool.get_by_role("button", name="Seal exact appearance and save PDF", exact=True).click()
        expect(tool.locator(".exact-status")).to_contain_text("PDF download started", timeout=120000)
    saved.value.save_as(target)
    assert target.read_bytes().startswith(b"%PDF-"), "Sealing must download a real PDF"
    assert target.read_bytes() != synthetic_pdf(pages)
    expect(tool.locator(".exact-profile")).to_contain_text(f"Sealed {pages} page(s)")
    # Sealing preflight is not displayed as a new independent user check.
    expect(tool.get_by_test_id("exact-document-result")).to_have_count(0)
    return target


def verify_file(tool, file):
    tool.get_by_label("Open exact-mode PDF", exact=True).set_input_files(file)
    expect(tool.get_by_test_id("exact-document-result")).to_have_count(0)
    tool.get_by_role("button", name="Verify exact rendered appearance", exact=True).click()
    expect(tool.locator(".exact-status")).to_contain_text("check finished", timeout=120000)
    return tool.locator(".exact-page-result")


def assert_complete_match(tool, pages):
    expect(tool.get_by_test_id("exact-document-result")).to_have_text("Complete exact rendered document match")
    results = tool.locator(".exact-page-result")
    expect(results).to_have_count(pages)
    for index in range(pages):
        expect(results.nth(index)).to_contain_text("Signature: Authenticated")
        expect(results.nth(index)).to_contain_text("Appearance: Exact rendered appearance matches")
        expect(results.nth(index)).to_have_attribute("data-appearance-status", "exact-render-match")


def assert_not_complete(tool):
    expect(tool.get_by_test_id("exact-document-result")).to_have_text("Complete exact rendered document match not established")
    expect(tool.get_by_test_id("exact-document-result")).to_have_class("exact-inconclusive")


def make_control(source, target, mode):
    # Re-serialize an actual altered PDF with the production pdf-lib dependency.
    # No fixture raster, signed source, record sidecar or verification hook is
    # injected into the browser. All judgments come from its real optical path.
    script = """
        import fs from 'node:fs';
        import { PDFDocument, rgb } from 'pdf-lib';
        const [source, target, mode] = process.argv.slice(1);
        const original = await PDFDocument.load(fs.readFileSync(source));
        let pdf = original;
        if (mode === 'visible') {
          const page = pdf.getPage(0);
          page.drawRectangle({ x: 250, y: 407, width: 90, height: 17, color: rgb(1, 1, 1) });
          page.drawText('Amount: 90.00', { x: 250, y: 410, size: 12, color: rgb(0, 0, 0) });
        } else if (mode === 'invisible') {
          pdf.setSubject('Changed metadata is intentionally outside the rendered-appearance claim.');
          pdf.getPage(0).drawText('INVISIBLE EXTRA ACCOUNT DATA', { x: 220, y: 320, size: 12, opacity: 0 });
        } else if (mode === 'reordered' || mode === 'missing') {
          pdf = await PDFDocument.create();
          const indices = mode === 'missing' ? [0] : original.getPageIndices().reverse();
          for (const page of await pdf.copyPages(original, indices)) pdf.addPage(page);
        } else throw Error('Unknown synthetic control');
        fs.writeFileSync(target, await pdf.save());
    """
    subprocess.run(["node", "--input-type=module", "-e", script, str(source), str(target), mode],
                   cwd=ROOT / "frontend", check=True, capture_output=True, text=True)
    assert target.read_bytes() != source.read_bytes()
    return target


def assert_no_document_storage(page, guard):
    state = page.evaluate("""async () => ({
      local: Object.entries(localStorage), session: Object.entries(sessionStorage),
      databases: typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [],
      caches: (await Promise.all((await caches.keys()).map(async name =>
        (await (await caches.open(name)).keys()).map(request => request.url)))).flat(),
    })""")
    assert state["local"] == [] and state["session"] == [] and state["databases"] == []
    # Public caches may contain only same-origin application resource URLs,
    # never blobs, uploads, data-bearing query strings or document filenames.
    for url in state["caches"]:
        from urllib.parse import urlsplit
        parsed = urlsplit(url)
        assert (parsed.scheme, parsed.netloc) == (guard.origin.scheme, guard.origin.netloc)
        assert parsed.path in guard.public_paths and not parsed.query
    guard.assert_quiet()


def test_exact_pdf_download_reupload_and_offline_verification(browser, tmp_path):
    creator = browser.new_context(service_workers="allow", accept_downloads=True)
    try:
        creator_guard = OfflineNetworkGuard(creator)
        creator_page = creator.new_page()
        open_experiment(creator_page)
        sealed = seal_and_download(creator_page, tmp_path / "generated-exact-sealed.pdf")
        assert_no_document_storage(creator_page, creator_guard)
    finally:
        creator.close()

    # A fresh browser context has never seen the source or private signing key.
    verifier = browser.new_context(service_workers="allow", viewport={"width": 430, "height": 932})
    try:
        guard = OfflineNetworkGuard(verifier)
        page = verifier.new_page()
        tool = open_experiment(page)
        expect(tool.get_by_label("Exact-mode private key (for sealing only)", exact=True)).to_have_value("")
        tool.get_by_label("Exact-mode public key", exact=True).fill(PUBLIC_KEY)
        verify_file(tool, sealed)
        assert_complete_match(tool, 2)
        wait_for_offline_resources(page, pdf=True)
        page.wait_for_load_state("networkidle")
        guard.check_instrumentation(page)
        guard.block()
        assert page.evaluate("navigator.onLine") is False
        verify_file(tool, sealed)
        assert_complete_match(tool, 2)
        assert_no_document_storage(page, guard)
        page.screenshot(path=str(tmp_path / "exact-pdf-mobile-result.png"), full_page=True)
        tool.get_by_role("button", name="Clear experimental documents and keys", exact=True).click()
        expect(tool.locator(".exact-status")).to_contain_text("Experimental check cleared")
        expect(tool.get_by_test_id("exact-document-result")).to_have_count(0)
        expect(tool.get_by_label("Exact-mode public key", exact=True)).to_have_value("")
        expect(tool.locator(".exact-file-name")).to_have_count(0)
        # Sealing is also exercised fully offline after all required assets
        # have been loaded by real verification. No private key is required
        # for the independent verification above.
        seal_and_download(page, tmp_path / "offline-generated-exact.pdf")
        assert_no_document_storage(page, guard)
        tool.get_by_role("button", name="Close exact PDF experiment", exact=True).click()
        expect(page.get_by_label("Open exact-mode PDF", exact=True)).to_have_count(0)
        page.get_by_role("button", name="Open experimental exact PDF tool", exact=True).click()
        expect(page.get_by_label("Exact-mode private key (for sealing only)", exact=True)).to_have_value("")
        expect(page.locator(".exact-results")).to_have_count(0)
    finally:
        verifier.close()


@pytest.mark.parametrize("control", ["visible", "invisible", "reordered", "missing"])
def test_exact_pdf_tamper_and_scope_controls(browser, tmp_path, control):
    context = browser.new_context(service_workers="allow", accept_downloads=True)
    try:
        guard = OfflineNetworkGuard(context)
        page = context.new_page()
        tool = open_experiment(page)
        sealed = seal_and_download(page, tmp_path / "sealed.pdf")
        altered = make_control(sealed, tmp_path / f"{control}.pdf", control)
        # Clear original source and private key before any verification.
        tool.get_by_role("button", name="Clear experimental documents and keys", exact=True).click()
        tool.get_by_label("Exact-mode public key", exact=True).fill(PUBLIC_KEY)
        results = verify_file(tool, altered)
        if control == "invisible":
            # Deliberately accepted, byte-different PDF. This is the documented
            # finite-rendering/hidden-data scope boundary, not a tamper win.
            assert_complete_match(tool, 2)
        elif control == "visible":
            assert_not_complete(tool)
            expect(results.nth(0)).to_contain_text("Signature: Authenticated")
            expect(results.nth(0)).to_have_attribute("data-appearance-status", "inconclusive")
            expect(results.nth(0).locator(".exact-match")).to_have_count(0)
            expect(results.nth(1)).to_have_attribute("data-appearance-status", "exact-render-match")
        else:
            assert_not_complete(tool)
        assert_no_document_storage(page, guard)
    finally:
        context.close()


def test_exact_pdf_wrong_key_plain_input_and_image_never_match(browser, tmp_path):
    context = browser.new_context(service_workers="allow", accept_downloads=True)
    try:
        guard = OfflineNetworkGuard(context)
        page = context.new_page()
        tool = open_experiment(page)
        sealed = seal_and_download(page, tmp_path / "sealed.pdf", pages=1)
        tool.get_by_role("button", name="Clear experimental documents and keys", exact=True).click()
        # A well-formed but unrelated public key must never give green results.
        tool.get_by_role("button", name="Generate experimental key pair", exact=True).click()
        expect(tool.locator(".exact-status")).to_contain_text("Key pair generated locally")
        verify_file(tool, sealed)
        assert_not_complete(tool)
        expect(tool.locator(".exact-match")).to_have_count(0)
        tool.get_by_label("Exact-mode public key", exact=True).fill(PUBLIC_KEY)
        verify_file(tool, {"name": "plain.pdf", "mimeType": "application/pdf", "buffer": synthetic_pdf(1)})
        assert_not_complete(tool)
        expect(tool.locator(".exact-match")).to_have_count(0)
        tool.get_by_label("Open exact-mode PDF", exact=True).set_input_files({
            "name": "photo.png", "mimeType": "image/png", "buffer": b"synthetic-not-a-pdf",
        })
        expect(tool.locator(".exact-status")).to_contain_text("Choose a digital PDF, not a photo or image")
        expect(tool.get_by_test_id("exact-document-result")).to_have_count(0)
        assert_no_document_storage(page, guard)
    finally:
        context.close()
