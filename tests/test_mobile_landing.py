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

def test_stamp_tool_asks_for_pdf_and_layout_before_signing_method(page):
    page.set_viewport_size({"width": 393, "height": 700})
    page.goto(BASE_URL)
    page.get_by_role("button", name="Open PDF stamping tool").click()

    pdf = page.get_by_label("Open PDF", exact=True)
    layout = page.get_by_label("Page layout", exact=True)
    choices = page.locator(".sealing-method-grid button")
    expect(pdf).to_be_visible()
    expect(layout).to_be_visible()
    expect(layout).to_have_value("automatic")
    expect(choices).to_have_count(4)
    assert choices.all_text_contents() == [
        "Authenticate with Google login",
        "Authenticate with Microsoft login",
        "Authenticate with Amazon login",
        "Private key (offline)",
    ]
    assert page.evaluate("""() => {
      const pdf = document.querySelector("#pdf-to-stamp");
      const layout = document.querySelector("select[aria-label='Page layout']");
      const auth = document.querySelector(".sealing-method-grid button");
      return Boolean(pdf.compareDocumentPosition(layout) & Node.DOCUMENT_POSITION_FOLLOWING) &&
             Boolean(layout.compareDocumentPosition(auth) & Node.DOCUMENT_POSITION_FOLLOWING);
    }""")
    assert all(button.get_attribute("aria-pressed") == "false" for button in choices.all())
    expect(page.get_by_label("Private Key", exact=True)).to_have_count(0)
    expect(page.get_by_role("button", name="Stamp and save PDF")).to_have_count(0)

    choices.last.click()
    expect(page.get_by_label("Private Key", exact=True)).to_be_visible()
    expect(page.get_by_role("button", name="Stamp and save PDF")).to_be_visible()

@pytest.mark.parametrize("provider,provider_url", [
    ("Google", "https://accounts.google.com/o/oauth2/v2/auth"),
    ("Microsoft", "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"),
    ("Amazon", "https://www.amazon.com/ap/oa"),
])
def test_prepared_provider_link_opens_direct_popup_without_losing_pdf(page, provider, provider_url):
    """Provider opens in a real isolated browser context, without a QRed waiting tab."""
    import json
    from pathlib import Path

    file_path = Path(__file__).parent / "fixtures" / "live-qa-invoice.pdf"
    calls = []

    def auth_api(route):
        url = route.request.url
        calls.append({"url": url, "body": route.request.post_data or ""})
        if url.endswith("/api/auth/config"):
            route.fulfill(status=200, content_type="application/json", body=json.dumps({
                "google": True, "microsoft": True, "amazon": True,
            }))
            return
        for name, address in [
            ("google", "https://accounts.google.com/o/oauth2/v2/auth"),
            ("microsoft", "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"),
            ("amazon", "https://www.amazon.com/ap/oa"),
        ]:
            if url.endswith("/api/auth/" + name + "/start"):
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps({
                                  "id": ("session" + name).ljust(43, "a"),
                                  "secret": ("secret" + name).ljust(43, "b"),
                                  "authorize_url": address + "?state=" + name,
                              }))
                return
        if url.endswith("/status"):
            route.fulfill(status=200, content_type="application/json",
                          body='{"status":"pending"}')
            return
        if url.endswith("/finish"):
            route.fulfill(status=200, content_type="application/json",
                          body='{"finished":true}')
            return
        route.abort()

    page.route("**/api/auth/**", auth_api)
    page.context.route(provider_url + "**",
                       lambda route: route.fulfill(status=200, content_type="text/html",
                                                   body="<h1>Provider login page</h1>"))
    page.goto(BASE_URL)
    page.get_by_role("button", name="Open PDF stamping tool").click()
    page.get_by_label("Open PDF", exact=True).set_input_files(str(file_path))
    link = page.get_by_role("link", name="Authenticate with " + provider + " login")
    expect(link).to_be_visible(timeout=30000)
    assert link.get_attribute("href").startswith(provider_url)
    assert "noopener" in link.get_attribute("rel")

    with page.context.expect_page() as popup_event:
        link.click()
    popup = popup_event.value
    expect(popup.get_by_role("heading", name="Provider login page")).to_be_visible()
    assert popup.url.startswith(provider_url)
    assert "auth-pending" not in popup.url
    assert page.evaluate("""() => ({
      count: document.querySelector("#pdf-to-stamp").files.length,
      filename: document.querySelector("#pdf-to-stamp").files[0].name
    })""") == {"count": 1, "filename": "live-qa-invoice.pdf"}

    # The only network requests bearing a document commitment go to QRed,
    # never to the third-party provider. No PDF bytes are in any auth body.
    for call in calls:
        assert "%PDF" not in call["body"]
        assert "Invoice" not in call["body"]
    popup.close()
