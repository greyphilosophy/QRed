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

def test_detached_preparation_tab_accepts_same_origin_handoff(page):
    """Real Chromium test: opener isolation must not strand an open tab."""
    import re

    page.goto(BASE_URL)
    token = "a" * 32
    page.evaluate("""token => {
        const channel = new BroadcastChannel("qred-auth-pending-" + token);
        window.__testAuthChannel = channel;
        window.__testAuthReady = false;
        channel.onmessage = event => {
          if (event.data?.type === "ready") window.__testAuthReady = true;
        };
        const button = document.createElement("button");
        button.textContent = "Open test preparation tab";
        button.onclick = () => {
          const popup = window.open("/auth-pending.html#" + token, "_blank");
          popup.opener = null;
          window.__testPopupWasOpened = Boolean(popup);
        };
        document.body.appendChild(button);
    }""", token)
    with page.context.expect_page() as popup_event:
        page.get_by_role("button", name="Open test preparation tab").click()
    pending = popup_event.value
    pending.wait_for_load_state("domcontentloaded")
    expect(pending.get_by_role("heading", name="Preparing secure sign-in")).to_be_visible()
    page.wait_for_function("window.__testAuthReady === true")

    # A forged or unexpected destination must never be opened.
    page.evaluate("""() => window.__testAuthChannel.postMessage({
      type: "authorize", provider: "google", url: "https://malicious.example/login"
    })""")
    pending.wait_for_timeout(100)
    assert "/auth-pending.html#" in pending.url

    # The actual callback URL navigates in the child's own context, even
    # though it cannot use the original tab's WindowProxy after isolation.
    pending.route("https://accounts.google.com/**",
                  lambda route: route.fulfill(status=200, content_type="text/html",
                                              body="<h1>Provider test interception</h1>"))
    page.evaluate("""() => window.__testAuthChannel.postMessage({
      type: "authorize",
      provider: "google",
      url: "https://accounts.google.com/o/oauth2/v2/auth?state=redacted"
    })""")
    expect(pending).to_have_url(re.compile(r"https://accounts\\.google\\.com/o/oauth2/v2/auth"))
    expect(pending.get_by_role("heading", name="Provider test interception")).to_be_visible()
