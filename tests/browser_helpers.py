"""Production browser workflows shared by the synthetic regression tests."""
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect

BASE_URL = os.environ.get("QRED_BASE_URL", "http://localhost:3000")


def wait_for_offline_resources(page, *, pdf=False):
    page.wait_for_function("navigator.serviceWorker.controller?.state === 'activated'", timeout=10000)
    if pdf:
        page.wait_for_function(r"""async () => {
            const entries = await Promise.all((await caches.keys()).map(async key =>
                (await (await caches.open(key)).keys()).map(request => request.url)));
            return entries.flat().some(url => /\/assets\/pdf\.worker\.min-[\w-]+\.mjs$/.test(url));
        }""", timeout=10000)


class OfflineNetworkGuard:
    """Allow public resource preparation, then observe and block real traffic.

    Install before creating a page. Routing disables ordinary HTTP caching;
    service-worker cache reads remain available. WebSockets never connect.
    """
    def __init__(self, context, base_url=BASE_URL):
        self.context = context
        self.preparing = True
        self.attempts = []
        self.origin = urlsplit(base_url)
        build = Path(__file__).resolve().parents[1] / "frontend" / "build"
        assert (build / "index.html").is_file(), "Build the production frontend before this test"
        self.public_paths = {"/" + path.relative_to(build).as_posix() for path in build.rglob("*") if path.is_file()}
        self.public_paths.update({"/", "/api/keys/default"})
        context.route(re.compile(r"^https?://"), self._http)
        context.route_web_socket(re.compile(r"^wss?://"), lambda socket: self.attempts.append(f"WebSocket {socket.url}"))

    def _http(self, route):
        request, target = route.request, urlsplit(route.request.url)
        if (self.preparing and request.method == "GET" and request.post_data is None
                and (target.scheme, target.netloc) == (self.origin.scheme, self.origin.netloc)
                and target.path in self.public_paths and not target.query):
            route.continue_()
        else:
            self.attempts.append(f"{request.method} {request.url}")
            route.abort("blockedbyclient")

    def block(self, *, offline=True):
        self.assert_quiet()
        self.preparing = False
        self.context.set_offline(offline)

    def allow_resources(self):
        self.context.set_offline(False)
        self.preparing = True

    def assert_quiet(self):
        assert self.attempts == [], "Unexpected network traffic: " + repr(self.attempts)

    def check_instrumentation(self, page):
        self.assert_quiet()
        self.preparing = False
        page.evaluate("() => fetch('/__privacy_page_probe__', {method: 'POST'}).catch(() => {})")
        self.context.service_workers[0].evaluate("() => fetch('/__privacy_worker_probe__').catch(() => {})")
        page.evaluate("() => { new WebSocket(location.origin.replace(/^http/, 'ws') + '/__privacy_socket_probe__'); }")
        for _ in range(50):
            if any('__privacy_socket_probe__' in request for request in self.attempts):
                break
            page.wait_for_timeout(100)
        for probe in ['__privacy_page_probe__', '__privacy_worker_probe__', '__privacy_socket_probe__']:
            assert any(probe in request for request in self.attempts), f"Guard missed {probe}"
        self.attempts.clear()


def stamp_and_save(page, source, destination=None):
    """Stamp through the real UI; return the saved PDF path and fresh seal result."""
    page.get_by_label("Open PDF", exact=True).set_input_files(source)
    page.evaluate("window.__qredTestMode = true; window.__lastSealResult = null")
    with page.expect_download(timeout=60000) as saved:
        page.get_by_role("button", name="Stamp and save PDF", exact=True).click()
        page.wait_for_function("""() => window.__lastSealResult ||
            document.querySelector('#stamp-result')?.textContent.includes('PDF sealing failed:')""", timeout=60000)
        message = page.locator("#stamp-result").inner_text()
        assert "PDF sealing failed:" not in message, message
    if destination is None:
        path = Path(saved.value.path())
    else:
        path = Path(destination)
        saved.value.save_as(path)
    assert path.read_bytes().startswith(b"%PDF-"), "The saved seal is not a PDF"
    expect(page.locator("#stamp-result")).to_contain_text("in this browser.")
    return path, page.evaluate("window.__lastSealResult")
