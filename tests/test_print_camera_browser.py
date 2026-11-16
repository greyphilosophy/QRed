"""Production PDF -> printer dots -> camera -> real browser scanner + OCR.

Reference and workflow cases are hard gates. The named stress sweep measures
the current limits; an optical miss there is recorded, never called a pass.
"""

import base64
import json
import os
from pathlib import Path
import subprocess
import time

import pytest
from playwright.sync_api import expect
from browser_helpers import (
    OfflineNetworkGuard,
    prepare_text_for_offline,
    wait_for_offline_resources,
)
from print_camera import PRESETS, rasterize, save_case
from simulation_browser import camera_images, observe_workers, upload_and_measure

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path(os.environ.get("QRED_SIM_OUTPUT", ROOT / "simulation-results"))
BASE = os.environ.get("QRED_BASE_URL", "http://localhost:3000")


@pytest.fixture(scope="module")
def simulated_documents():
    documents = OUTPUT / "documents"
    subprocess.run(
        [
            "node",
            "node_modules/vite-node/vite-node.mjs",
            "scripts/prepareSimulationDocuments.mjs",
        ],
        cwd=ROOT / "frontend",
        env={**os.environ, "QRED_SIM_OUTPUT": str(documents)},
        check=True,
        timeout=120,
    )
    return documents, json.loads((documents / "manifest.json").read_text())


@pytest.fixture(scope="module")
def plain_photos(simulated_documents):
    documents, _ = simulated_documents
    out = OUTPUT / "plain"
    photos = {}
    for name, filename, page in [
        ("first", "plain-sealed.pdf", 1),
        ("second", "plain-sealed.pdf", 2),
        ("altered", "plain-altered.pdf", 2),
    ]:
        raster = rasterize(documents / filename, page, 300)
        for camera in ("preview", "reference"):
            photos[name, camera], _ = save_case(
                documents / filename,
                page,
                PRESETS[camera],
                out,
                name + "-" + camera,
                raster,
            )
    return photos


def open_verifier(browser, path, key, offline=False):
    context = browser.new_context(
        service_workers="allow", viewport={"width": 393, "height": 873}
    )
    guard = OfflineNetworkGuard(context, BASE)
    context.route(
        "**/api/keys/default", lambda route: route.fulfill(json={"public_key": key})
    )
    page = context.new_page()
    page.goto(BASE + path, wait_until="networkidle")
    if path != "/":
        page.locator("#publicKeyFileInput").set_input_files(
            {
                "name": "demo-public.txt",
                "mimeType": "text/plain",
                "buffer": key.encode(),
            }
        )
    prepare_text_for_offline(page)
    wait_for_offline_resources(page, photo=True)
    page.wait_for_load_state("networkidle")
    observe_workers(page)
    if offline:
        guard.block(offline=True)
    return context, page, guard


def test_printed_photo_upload_completes_and_flags_changed_amount(
    browser, simulated_documents, plain_photos
):
    # The home verifier owns the image picker. Both routes' camera workflows
    # are exercised below; the standalone route currently has PDF input only.
    path = "/"
    _, manifest = simulated_documents
    document = manifest["documents"][0]
    context, page, guard = open_verifier(
        browser, path, manifest["publicKey"], offline=True
    )
    out = OUTPUT / ("upload-home" if path == "/" else "upload-standalone")
    try:
        first = upload_and_measure(
            page,
            plain_photos["first", "reference"],
            document["pages"][0]["seals"],
            document["pages"][0]["text"],
            out,
            "unchanged",
        )
        assert first["seal_recovered"]
        changed = upload_and_measure(
            page,
            plain_photos["altered", "reference"],
            document["pages"][1]["seals"],
            document["pages"][1]["text"],
            out,
            "changed",
            expected_pages=2,
            content_changed=True,
        )
        assert changed["seal_recovered"]
        assert (
            "123.45" in changed["review"] and changed["content_difference_groups"] > 0
        ), changed
        expect(
            page.get_by_role("region", name="Document check").get_by_text(
                "All 2 pages collected.", exact=True
            )
        ).to_be_visible()
        page.get_by_role("button", name="Finish & clear", exact=True).click()
        expect(page.locator(".photo-stage img")).to_have_count(0)
        guard.assert_quiet()
        # Evaluate unchanged-page quality after collecting both measurements,
        # so an OCR failure cannot hide the altered-document result.
        assert first["ocr_status"] == "Recognized text matches the signed text", first
        assert first["content_difference_groups"] == 0, first
    finally:
        context.close()


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
def test_halftone_camera_sequence_next_page_and_frozen_retake(
    browser, simulated_documents, plain_photos, path
):
    _, manifest = simulated_documents
    context, page, guard = open_verifier(
        browser, path, manifest["publicKey"], offline=True
    )
    out = OUTPUT / ("camera-home" if path == "/" else "camera-standalone")
    out.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    report = {"browser_version": browser.version}
    try:
        camera_images(
            page, plain_photos["first", "preview"], plain_photos["first", "reference"]
        )
        page.get_by_role("button", name="Check document", exact=True).click()
        expect(page.locator(".page-check-list button")).to_have_count(1, timeout=25000)
        report["first_capture_seconds"] = round(time.monotonic() - started, 3)
        expect(
            page.get_by_text(
                "Move the page to capture again, or use Capture now.", exact=True
            )
        ).to_be_visible(timeout=5000)
        page.wait_for_timeout(1800)
        assert page.evaluate("__simulationCamera.requests") == 1
        camera_images(
            page,
            plain_photos["altered", "preview"],
            plain_photos["altered", "reference"],
        )
        expect(page.locator(".page-check-list button")).to_have_count(2, timeout=25000)
        expect(
            page.get_by_role("region", name="Document check").get_by_text(
                "All 2 pages collected.", exact=True
            )
        ).to_be_visible()
        page.locator(".page-check-list button").last.click()
        review = page.get_by_role("region", name="Review Page 2 of 2", exact=True)
        expect(review.locator(".photo-differences")).to_contain_text(
            "123.45", timeout=60000
        )
        assert page.evaluate(
            "__simulationCamera.tracks.every(t=>t.readyState==='ended')"
        )
        # An independent high-detail still is frozen before acknowledgement.
        # Moving the video scene immediately afterward cannot replace it.
        camera_images(
            page, plain_photos["second", "preview"], plain_photos["second", "reference"]
        )
        page.evaluate("__simulationCamera.removeOnCapture=true")
        review.get_by_role("button", name="Retake this page", exact=True).click()
        expect(page.get_by_role("dialog")).to_have_count(0, timeout=30000)
        page.wait_for_function(
            "!document.querySelector('.page-check-status.queued, .page-check-status.reading')",
            timeout=60000,
        )
        # Check the actual retained photograph, independently of OCR accuracy.
        original = (
            "data:image/jpeg;base64,"
            + base64.b64encode(
                plain_photos["second", "reference"].read_bytes()
            ).decode()
        )
        delta = review.locator(".photo-stage img").evaluate(
            """async (retained, url) => {
            const source = new Image();source.src=url;await source.decode();await retained.decode();
            if (source.naturalWidth!==retained.naturalWidth || source.naturalHeight!==retained.naturalHeight) return Infinity;
            const canvas=document.createElement('canvas');canvas.width=source.naturalWidth;canvas.height=source.naturalHeight;
            const ctx=canvas.getContext('2d');ctx.drawImage(source,0,0);const a=ctx.getImageData(0,0,canvas.width,canvas.height).data;
            ctx.drawImage(retained,0,0);const b=ctx.getImageData(0,0,canvas.width,canvas.height).data;
            let largest=0;for(let i=0;i<a.length;i+=97)largest=Math.max(largest,Math.abs(a[i]-b[i]));return largest;
        }""",
            original,
        )
        assert delta <= 1, "Retake did not retain the acknowledged still photograph"
        assert page.evaluate("__simulationCamera.notices") == 1
        page.get_by_role("button", name="Finish & clear", exact=True).click()
        assert page.evaluate(
            "__simulationCamera.tracks.every(t=>t.readyState==='ended')"
        )
        guard.assert_quiet()
        report["passed"] = True
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        report["total_seconds"] = round(time.monotonic() - started, 3)
        (out / "sequence.json").write_text(json.dumps(report, indent=2) + "\n")
        page.screenshot(path=str(out / "sequence.png"), full_page=True)
        context.close()


def test_dense_print_sweep_reports_optical_and_ocr_limits(browser, simulated_documents):
    documents, manifest = simulated_documents
    document = manifest["documents"][1]
    names = (
        list(PRESETS)
        if os.environ.get("QRED_SIM_SWEEP") == "1"
        else ["reference", "clustered", "low-dpi", "observed-scene"]
    )
    out = OUTPUT / "dense"
    reports = []
    rasters = {}
    try:
        for name in names:
            profile = PRESETS[name]
            if profile.printer.dpi not in rasters:
                rasters[profile.printer.dpi] = rasterize(
                    documents / document["file"], 1, profile.printer.dpi
                )
            photo, _ = save_case(
                documents / document["file"],
                1,
                profile,
                out,
                name,
                rasters[profile.printer.dpi],
            )
            context, page, guard = open_verifier(
                browser, "/", manifest["publicKey"], offline=True
            )
            try:
                result = upload_and_measure(
                    page,
                    photo,
                    document["pages"][0]["seals"],
                    document["pages"][0]["text"],
                    out,
                    name,
                )
                reports.append(result)
                guard.assert_quiet()
            finally:
                context.close()
        # The reference optical case is a release-blocking regression gate.
        # Dense OCR and stress recovery are explicit measurements, not claimed
        # solved by green CI. The report lists every miss and false alarm.
        assert reports[0]["seal_recovered"], reports[0]
    finally:
        out.mkdir(parents=True, exist_ok=True)
        (out / "sweep.json").write_text(
            json.dumps(
                {
                    "cases": reports,
                    "signed_pages_recovered": sum(r["seal_recovered"] for r in reports),
                    "attempts": len(reports),
                    "physical_acceptance": False,
                },
                indent=2,
            )
            + "\n"
        )


def test_complete_multipart_footer_recovers_every_chunk(browser, simulated_documents):
    documents, manifest = simulated_documents
    document = manifest["documents"][2]
    expected = document["pages"][0]
    assert len(expected["seals"]) >= 2
    out = OUTPUT / "multipart"
    photo, _ = save_case(
        documents / document["file"], 1, PRESETS["reference"], out, "reference"
    )
    context, page, guard = open_verifier(
        browser, "/", manifest["publicKey"], offline=True
    )
    try:
        result = upload_and_measure(
            page,
            photo,
            expected["seals"],
            expected["text"],
            out,
            "reference",
            read_text=False,
        )
        guard.assert_quiet()
        assert result["seal_recovered"], result
    finally:
        context.close()


def test_unsealed_print_never_authenticates(browser, simulated_documents):
    documents, manifest = simulated_documents
    out = OUTPUT / "unsealed"
    photo, _ = save_case(
        documents / "plain-source.pdf", 1, PRESETS["reference"], out, "reference"
    )
    context, page, guard = open_verifier(
        browser, "/", manifest["publicKey"], offline=True
    )
    try:
        result = upload_and_measure(
            page, photo, [], "", out, "reference", read_text=False
        )
        assert not result["seal_recovered"]
        assert result["scan_status"] == "feedback", result
        expect(page.locator(".page-check-list button")).to_have_count(0)
        guard.assert_quiet()
    finally:
        context.close()
