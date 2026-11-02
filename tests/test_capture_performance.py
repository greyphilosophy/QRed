"""Latency and responsiveness gates using real QR decoding and local OCR.

These generous CI limits catch the former 10–16s capture and 6–8s UI stalls.
They are not a phone benchmark or a guarantee for difficult printed pages.
"""
import json
import os
import time

import pytest
from playwright.sync_api import expect
from test_photo_verification import sealed_text, camera_paper, prepare_reader, TEXT, PUBLIC_KEY


@pytest.mark.parametrize("path", ["/", "/verify.htm"])
def test_whole_page_capture_and_comparison_stay_responsive(browser, sealed_text, path):
    context = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="allow")
    page = context.new_page()
    try:
        context.route("**/api/keys/default", lambda route: route.fulfill(json={"public_key": PUBLIC_KEY}))
        page.goto(os.environ.get("QRED_BASE_URL", "http://localhost:3000") + path, wait_until="networkidle")
        if path != "/":
            page.locator("#publicKeyFileInput").set_input_files({"name": "key.txt", "mimeType": "text/plain", "buffer": PUBLIC_KEY.encode()})
        # Measure the per-page work separately from downloading/starting OCR.
        prepare_reader(page)
        camera_paper(page, TEXT.replace("Friday", "Monday"), sealed_text[1]["qr"])
        page.evaluate("""() => {
            window.captureLongTasks = [];
            window.captureObserver = new PerformanceObserver(list => {
                for (const task of list.getEntries()) captureLongTasks.push(task.duration);
            });
            captureObserver.observe({type: 'longtask'});
        }""")
        page.get_by_role("button", name="Check document", exact=True).click()
        page.wait_for_function("() => document.querySelector('video')?.readyState >= 2")
        started = time.monotonic()
        expect(page.locator(".page-check-list button")).to_have_count(1, timeout=6000)
        captured = time.monotonic()
        page.get_by_role("button", name="Check this page now", exact=True).click()
        review = page.get_by_role("region", name="Review Page 2 of 2", exact=True)
        expect(review.locator(".photo-differences")).to_contain_text("Monday", timeout=4000)
        finished = time.monotonic()
        longest_task = page.evaluate("Math.max(0, ...captureLongTasks)")
        print("Capture performance: " + json.dumps({"path": path, "capture_seconds": captured - started,
            "comparison_seconds": finished - captured, "longest_ui_task_ms": longest_task}))
        assert finished - started < 8, "A clear four-line page should not enter the exhaustive recovery path"
        assert longest_task < 1000, "Image preparation must not freeze the UI"
        page.get_by_role("button", name="Finish & clear", exact=True).click()
        assert page.evaluate("window.__cameraTracks.every(track => track.readyState === 'ended')")
    finally:
        context.close()
