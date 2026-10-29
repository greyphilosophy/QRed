"""Mobile landing screen: both primary QRed workflows must be visible on arrival."""

import pytest
from playwright.sync_api import expect
from browser_helpers import BASE_URL


@pytest.mark.parametrize("width,height", [
    (320, 568),  # compact phone
    (360, 640),
    (393, 700),  # phone with browser chrome visible
    (430, 932),  # tall phone
])
def test_mobile_shows_scan_and_stamp_without_scrolling(page, width, height):
    page.set_viewport_size({"width": width, "height": height})
    page.goto(BASE_URL)

    expect(page.get_by_role("heading", name="Scan a QRed seal")).to_be_visible()
    scan = page.get_by_role("button", name="Start scanning")
    stamp = page.get_by_role("button", name="Open PDF stamping tool")
    expect(scan).to_be_visible()
    expect(stamp).to_be_visible()

    # A visible button can still be cut off below the browser viewport;
    # require the entire touch target to fit without scrolling.
    viewport_height = page.evaluate("window.innerHeight")
    scan_box = scan.bounding_box()
    stamp_box = stamp.bounding_box()
    for button_box in (scan_box, stamp_box):
        assert button_box is not None
        assert button_box["y"] >= 0, (width, height, button_box)
        assert button_box["y"] + button_box["height"] <= viewport_height, (
            width, height, viewport_height, button_box
        )
        assert button_box["height"] >= 44

    # The Stamp PDF action must still open its actual stamping workflow.
    stamp.click()
    expect(page.get_by_role("heading", name="Stamp a PDF with QRed seals")).to_be_visible()


def test_desktop_keeps_scan_and_stamp_side_by_side(page):
    page.set_viewport_size({"width": 1280, "height": 800})
    page.goto(BASE_URL)
    scan = page.get_by_role("button", name="Start scanning")
    stamp = page.get_by_role("button", name="Open PDF stamping tool")
    expect(scan).to_be_visible()
    expect(stamp).to_be_visible()
    scan_box = scan.bounding_box()
    stamp_box = stamp.bounding_box()
    assert scan_box is not None and stamp_box is not None
    assert abs(scan_box["y"] - stamp_box["y"]) < 3
    assert stamp_box["x"] > scan_box["x"]
