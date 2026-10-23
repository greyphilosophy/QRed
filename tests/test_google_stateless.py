"""Exercise real browser cookies and the stateless protocol with synthetic Google.

No live Google account, production authority secret or database is used.
"""

import json
import subprocess
from pathlib import Path

import pytest
from playwright.sync_api import expect


@pytest.fixture
def google_test_bridge():
    root = Path(__file__).resolve().parents[1]
    process = subprocess.Popen(
        ["node", str(root / "tests/google_stateless_server.mjs")],
        cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        line = process.stdout.readline()
        assert line, process.stderr.read()
        port = json.loads(line)["port"]
        yield f"http://127.0.0.1:{port}/"
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def test_stateless_google_cookie_handoff_and_offline_verification(browser, playwright, google_test_bridge):
    context = browser.new_context(service_workers="block")
    bridge_client = playwright.request.new_context()
    requests = []

    def local_bridge(route):
        request = route.request
        assert request.url.startswith(("https://qred.test/", "https://accounts.google.com/"))
        requests.append((request.url, request.post_data or ""))
        headers = request.all_headers()
        # Keep the relay's HTTP cookie jar separate. Only cookies actually sent
        # by Chromium to the original HTTPS origin may reach the Worker.
        response = bridge_client.fetch(
            google_test_bridge, method=request.method, data=request.post_data_buffer,
            headers={**headers, "cookie": headers.get("cookie", ""), "x-qred-test-url": request.url},
            max_redirects=0,
        )
        route.fulfill(response=response)

    try:
        context.route("**/*", local_bridge)
        page = context.new_page()
        page.goto("https://qred.test/")
        with context.expect_page() as opened:
            page.get_by_role("button", name="Seal synthetic document").click()
        popup = opened.value
        popup.wait_for_url("https://accounts.google.com/**")
        expect(popup.get_by_role("button", name="Continue")).to_be_visible()
        assert popup.evaluate("window.opener === null")
        pending = [cookie for cookie in context.cookies() if cookie["name"].startswith("__Host-qred-request-")]
        assert len(pending) == 1
        assert pending[0]["httpOnly"] and pending[0]["secure"]
        assert pending[0]["sameSite"] == "Lax"
        assert pending[0]["domain"] == "qred.test"
        assert len(pending[0]["value"].split(".")) == 5  # Encrypted JWE, not readable JWT.
        popup.get_by_role("button", name="Continue").click()
        expect(page.locator("output")).to_have_attribute("data-status", "valid", timeout=15000)
        results = json.loads(page.locator("output").text_content())
        assert [result["page_number"] for result in results] == [1, 2, 3]
        assert len({result["timestamp"] for result in results}) == 1
        assert results[1]["evidence"]["visual"]["codebook"] == 1
        assert results[2]["evidence"]["blank"] is True
        assert all(result["identity_authenticated"] for result in results)
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
