"""Drive the real application; expected content is used only by test assertions."""

import base64
import json
import os
from pathlib import Path
import time

from playwright.sync_api import TimeoutError as BrowserTimeout, expect
from browser_helpers import show_file_inputs


def observe_workers(page):
    # Observe completion of the REAL production worker. No decoder/recognizer
    # replacement, image hints, supplied corners, or expected text enter it.
    page.evaluate("""() => {
        window.__simulationActions = [];
        const Original = window.Worker;
        window.Worker = class extends Original {
            constructor(...args) {
                super(...args);
                this.addEventListener('message', ({data}) => {
                    if (data.action?.status) __simulationActions.push({action:data.action, at:performance.now()});
                });
            }
        };
    }""")


def upload_and_measure(
    page,
    photo,
    expected_seals,
    expected_text,
    output,
    name,
    expected_pages=1,
    read_text=True,
    content_changed=False,
):
    """Save measurements even for optical misses; callers define acceptance."""
    result = {
        "name": name,
        "photo": Path(photo).name,
        "photo_relative": os.path.relpath(photo, output),
        "browser_version": page.context.browser.version,
        "seal_recovered": False,
        "ocr_status": "not-run",
        "content_difference_groups": None,
        "expected_authentication": bool(expected_seals),
        "content_changed": content_changed,
    }
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    try:
        show_file_inputs(page)
        page.evaluate("window.__simulationActions = []")
        page.locator("#qr-image").set_input_files(photo)
        try:
            page.wait_for_function(
                "window.__simulationActions.length > 0", timeout=20000
            )
        except BrowserTimeout:
            result["scan_status"] = "timeout"
            result["feedback"] = (
                "No scanner result within the 20-second acceptance limit"
            )
            return result
        action = page.evaluate("__simulationActions.at(-1).action")
        result["seal_seconds"] = round(time.monotonic() - started, 3)
        result["scan_status"] = action["status"]
        recovered = action.get("texts", [action["text"]] if "text" in action else [])
        if recovered:
            # An authenticated but different record is always a failure, even
            # for exploratory stress cases. Never silently count it as a pass.
            assert set(recovered) <= set(
                expected_seals
            ), "Recovered bytes differ from the signed source"
            result["chunks_recovered"] = len(set(recovered))
            result["chunks_expected"] = len(set(expected_seals))
            if set(recovered) != set(expected_seals):
                result["scan_status"] = "incomplete"
                return result
            expect(page.locator(".page-check-list button")).to_have_count(
                expected_pages, timeout=15000
            )
            result["seal_recovered"] = True
            # This text is emitted by signature verification, not OCR.
            signed = page.locator(".verification-result pre")
            assert expected_text in signed.all_text_contents()
            if not read_text:
                result["ocr_status"] = "not-measured (optical-only case)"
                return result
            page.wait_for_function(
                """() => {
                const states = [...document.querySelectorAll('.page-check-status')];
                return states.length && states.every(node => !/queued|reading|missing/.test(node.className));
            }""",
                timeout=60000,
            )
            page.locator(".page-check-list button").last.click()
            region = page.get_by_role("region", name="Review Page", exact=False)
            result["ocr_status"] = region.locator(".photo-summary").inner_text()
            result["content_difference_groups"] = region.locator(
                ".photo-differences > ol > li"
            ).count()
            result["typography_groups"] = region.locator(".photo-typography li").count()
            result["word_counts"] = region.locator(".photo-legend").all_text_contents()
            result["review"] = region.locator(".photo-differences").inner_text()
        else:
            result["feedback"] = action.get("message", "")
            assert page.locator(".page-check-list button").count() == 0
        return result
    except Exception as error:
        result["error"] = str(error)
        raise
    finally:
        result["total_seconds"] = round(time.monotonic() - started, 3)
        (output / (name + "-result.json")).write_text(
            json.dumps(result, indent=2) + "\n"
        )
        page.screenshot(path=str(output / (name + "-review.png")), full_page=True)


def camera_images(page, preview, still):
    """A real canvas MediaStream with separate, browser-decoded still pixels."""

    def url(path):
        mime = "image/jpeg" if Path(path).suffix == ".jpg" else "image/png"
        return (
            "data:"
            + mime
            + ";base64,"
            + base64.b64encode(Path(path).read_bytes()).decode()
        )

    page.evaluate(
        """async ({preview, still}) => {
        const image = new Image(); image.src = preview; await image.decode();
        const blob = await (await fetch(still)).blob();
        if (!window.__simulationCamera) {
            const canvas = document.createElement('canvas');
            const sim = window.__simulationCamera = {canvas, tracks:[], requests:0, removeOnCapture:false, notices:0};
            navigator.mediaDevices.getUserMedia = async () => {
                const stream = canvas.captureStream(15); sim.tracks.push(...stream.getTracks()); return stream;
            };
            navigator.mediaDevices.enumerateDevices = async () => [];
            window.ImageCapture = class {
                async getPhotoCapabilities() {
                    const bitmap = await createImageBitmap(sim.still);
                    const result = {imageWidth:{min:640,max:bitmap.width},imageHeight:{min:853,max:bitmap.height}};
                    bitmap.close(); return result;
                }
                async takePhoto() {
                    sim.requests++;
                    const frozen = sim.still;
                    await new Promise(resolve => setTimeout(resolve,100));
                    return frozen;
                }
            };
            setInterval(() => {
                if (sim.image) canvas.getContext('2d').drawImage(sim.image,0,0,canvas.width,canvas.height);
            },67);
            new MutationObserver(() => {
                const status = [...document.querySelectorAll('.ar-scan-feedback, #pageGuideHint, .page-camera [role="status"]')];
                if (sim.removeOnCapture && status.some(n=>n.textContent==='Photo captured — processing…')) {
                    sim.removeOnCapture=false; sim.notices++;
                    sim.image=null;
                    const ctx=canvas.getContext('2d');ctx.fillStyle='#444';ctx.fillRect(0,0,canvas.width,canvas.height);
                }
            }).observe(document.body,{subtree:true,childList:true,characterData:true});
        }
        const sim=__simulationCamera;
        sim.image=image; sim.still=blob;
        sim.canvas.width=image.naturalWidth;sim.canvas.height=image.naturalHeight;
        sim.canvas.getContext('2d').drawImage(image,0,0);
    }""",
        {"preview": url(preview), "still": url(still)},
    )
