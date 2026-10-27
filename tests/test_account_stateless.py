"""Exercise real browser cookies and the stateless protocol with synthetic providers.

No live provider account, production authority secret or database is used.
"""

import json
import subprocess
from pathlib import Path

import pytest
from playwright.sync_api import expect


@pytest.fixture(params=["google", "microsoft", "meta", "amazon"])
def account_test_bridge(request):
    root = Path(__file__).resolve().parents[1]
    process = subprocess.Popen(
        ["node", str(root / "tests/account_stateless_server.mjs"), request.param],
        cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        line = process.stdout.readline()
        assert line, process.stderr.read()
        port = json.loads(line)["port"]
        yield f"http://127.0.0.1:{port}/", request.param
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


@pytest.mark.parametrize("mobile", [False, True], ids=["desktop", "mobile"])
def test_stateless_account_cookie_handoff_and_offline_verification(browser, playwright, account_test_bridge, mobile):
    bridge_url, provider = account_test_bridge
    provider_origin = {"google": "https://accounts.google.com", "microsoft": "https://login.microsoftonline.com", "meta": "https://www.facebook.com", "amazon": "https://www.amazon.com"}[provider]
    context = browser.new_context(service_workers="block",
        **({"viewport": {"width": 430, "height": 932}, "is_mobile": True, "has_touch": True}
           if mobile else {}))
    bridge_client = playwright.request.new_context()
    requests = []

    def local_bridge(route):
        request = route.request
        assert request.url.startswith(("https://qred.test/", provider_origin + "/"))
        requests.append((request.url, request.post_data or ""))
        headers = request.all_headers()
        # Keep the relay's HTTP cookie jar separate. Only cookies actually sent
        # by Chromium to the original HTTPS origin may reach the Worker.
        response = bridge_client.fetch(
            bridge_url, method=request.method, data=request.post_data_buffer,
            headers={**headers, "cookie": headers.get("cookie", ""), "x-qred-test-url": request.url},
            max_redirects=0,
        )
        route.fulfill(response=response)

    try:
        context.route("**/*", local_bridge)
        page = context.new_page()
        page.goto("https://qred.test/")
        # The first click does PDF preparation and begins a short-lived session.
        # Mobile must NOT open a blank about:blank window before this work ends.
        page.get_by_role("button", name="Seal synthetic document").click()
        expect(page.get_by_role("button", name="Continue to provider")).to_be_visible()
        assert len(context.pages) == 1
        pending = [cookie for cookie in context.cookies() if cookie["name"].startswith("__Host-qred-") and "request-" in cookie["name"]]
        assert len(pending) == 1
        assert pending[0]["httpOnly"] and pending[0]["secure"]
        assert pending[0]["sameSite"] == "Lax"
        assert pending[0]["domain"] == "qred.test"
        assert len(pending[0]["value"].split(".")) == 5  # Encrypted JWE, not readable JWT.
        # Second user gesture opens a real provider URL immediately, never
        # about:blank. The parent tab can be paused while the provider is open.
        with context.expect_page() as opened:
            page.get_by_role("button", name="Continue to provider").click()
        popup = opened.value
        popup.wait_for_url(provider_origin + "/**")
        expect(popup.get_by_role("button", name="Continue")).to_be_visible()
        assert popup.evaluate("window.opener === null")
        popup.get_by_role("button", name="Continue").click()
        expect(page.locator("output")).to_have_attribute("data-status", "valid", timeout=15000)
        results = json.loads(page.locator("output").text_content())
        assert [result["page_number"] for result in results] == [1, 2, 3]
        assert len({result["timestamp"] for result in results}) == 1
        assert results[1]["evidence"]["visual"]["codebook"] == 1
        assert results[2]["evidence"]["blank"] is True
        assert all(result["identity_authenticated"] and result["identity"]["provider"] == provider for result in results)
        assert not [cookie for cookie in context.cookies() if cookie["name"].startswith("__Host-qred-")]
        wire = json.dumps(requests)
        assert "Synthetic private page" not in wire
        assert "d4" * 32 not in wire
        context.set_offline(True)
        before_verification = len(requests)
        verified = page.evaluate("window.verifyOffline()")
        assert all(result["status"] == "VALID" for result in verified)
        assert len(requests) == before_verification
    finally:
        context.close()
        bridge_client.dispose()
