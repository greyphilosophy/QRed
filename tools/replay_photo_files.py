"""Replay private original photos through both production verifier screens.

Requires requirements.txt and `playwright install chromium-headless-shell`.
Report hashes, timings and counts only; never save document text or images.
Exit 1 means a stage still needs attention, including a non-clean text result.
"""
import argparse
import functools
import hashlib
import http.server
import json
import subprocess
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


AUDIT = """() => {
  window.photoEvents = []; window.photoScanCount = 0;
  const OriginalWorker = window.Worker;
  window.Worker = class extends OriginalWorker {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', ({data}) => {
        if (data.scanStage) photoEvents.push({scan:this.photoScan, kind:'stage', stage:data.scanStage.stage,
          elapsedMs:data.scanStage.elapsedMs});
        if (data.action?.status) photoEvents.push({scan:this.photoScan, kind:'result', status:data.action.status});
      });
    }
    postMessage(data, ...args) {
      if (data?.image && !data.prepareReading) this.photoScan = ++photoScanCount;
      return super.postMessage(data, ...args);
    }
    terminate() { photoEvents.push({scan:this.photoScan, kind:'terminated'}); return super.terminate(); }
  };
}"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("photos", type=Path, nargs="+", help="One original image per document page")
    parser.add_argument("--output", type=Path, required=True, help="Metadata-only report outside the repository")
    parser.add_argument("--chromium", help="Optional installed Chromium executable")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if not (root / "frontend/build/verify.htm").exists():
        parser.error("Build first: cd frontend && npm run build:pages")

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
        functools.partial(Quiet, directory=str(root / "frontend/build")))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    report = {"commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
        "dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=root, text=True).strip()),
        "mode": "Saved-photo replay; not physical phone or camera acquisition acceptance",
        "photos": [{"sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "bytes": p.stat().st_size} for p in args.photos],
        "routes": []}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(**({"executable_path": args.chromium} if args.chromium else {}))
            report["browser"] = browser.version
            for route in ["/", "/verify.htm"]:
                result = {"route": route, "files": [], "blocked_requests": 0, "page_errors": 0}
                report["routes"].append(result)
                context = browser.new_context(viewport={"width": 360, "height": 800},
                    device_scale_factor=3, is_mobile=True, has_touch=True, service_workers="allow")

                def guard(request):
                    if request.request.url.startswith(origin + "/") and request.request.method == "GET":
                        request.continue_()
                    else:
                        result["blocked_requests"] += 1
                        request.abort()

                context.route("**/*", guard)
                context.add_init_script("(" + AUDIT + ")()")
                page = context.new_page()
                page.on("pageerror", lambda _: result.update(page_errors=result["page_errors"] + 1))
                try:
                    page.goto(origin + route, wait_until="networkidle")
                    page.get_by_text("Prepare for offline checking", exact=True).click()
                    page.get_by_role("button", name="Prepare offline checking", exact=True).click()
                    page.get_by_role("button", name="Offline text checking ready", exact=True).wait_for(state="attached", timeout=90000)
                    page.wait_for_function("""async () => (await Promise.all((await caches.keys()).map(async k =>
                      (await (await caches.open(k)).keys()).map(r => r.url)))).flat()
                      .some(url => /\\/assets\\/photoScan\\.worker-.*\\.js$/.test(url))""")
                    context.set_offline(True)
                    if route == "/":
                        page.get_by_text("Open an existing PDF or image", exact=True).click()
                    collection_started = time.monotonic()
                    for photo in args.photos:
                        before = page.evaluate("photoEvents.length")
                        scan = page.evaluate("photoScanCount")
                        started = time.monotonic()
                        page.locator("#qr-image" if route == "/" else "#pagePhotoInput").set_input_files(photo)
                        page.wait_for_function("scan => photoEvents.some(e => e.scan > scan && ['result','terminated'].includes(e.kind))",
                            arg=scan, timeout=75000)  # Allow for opening the file and a 60-second seal read.
                        result["files"].append({"milliseconds": round((time.monotonic() - started) * 1000),
                            "events": page.evaluate("start => photoEvents.slice(start)", before)})
                    if route != "/":
                        for name in ["Check this page now", "Check captured pages now", "Stop check"]:
                            button = page.get_by_role("button", name=name, exact=True)
                            if button.count():
                                button.first.click()
                                break
                    page.wait_for_function("""() => {const states = [...document.querySelectorAll('.page-check-status')];
                      return states.length && states.every(n => ['matches','differences','uncertain','unreadable','error']
                        .some(s => n.classList.contains(s)));} """, timeout=90000)
                    result["collection_and_text_ms"] = round((time.monotonic() - collection_started) * 1000)
                    result["pages"] = []
                    controls = page.get_by_role("navigation", name="Page checks")
                    chooser = controls.get_by_role("combobox")
                    buttons = controls.get_by_role("button")
                    for i in range(controls.locator(".page-check-status").count()):
                        if chooser.count():
                            chooser.select_option(index=i)
                        else:
                            buttons.nth(i).click()
                        result["pages"].append(page.locator('section[aria-label^="Review "]').evaluate("""n => ({
                          state:n.querySelector('.photo-summary').className.split(' ').at(-1),
                          counts:[...n.querySelectorAll('.photo-legend li')].map(x => Number(x.textContent.match(/\\d+/)?.[0])),
                          contentDifferences:Number(n.querySelector('.photo-differences')?.dataset.count || 0),
                          firstReadingDifferences:n.querySelectorAll('.photo-original-reading > ol > li').length,
                          rereads:n.querySelectorAll('.photo-retries > ol > li').length})"""))
                    page.get_by_role("button", name="Finish & clear", exact=True).click()
                    result["cleared"] = page.locator(".photo-stage img").count() == 0
                    result["all_seals_authenticated"] = len(result["pages"]) == len(args.photos)
                    result["clean_text"] = result["all_seals_authenticated"] and all(p["state"] == "matches" for p in result["pages"])
                except Exception as error:
                    # Error messages may contain private filenames or UI text.
                    result["error_type"] = type(error).__name__
                finally:
                    context.close()
            browser.close()
    finally:
        server.shutdown()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
    return 0 if all(r.get("clean_text") and r.get("cleared") and not r["page_errors"]
        and not r["blocked_requests"] for r in report["routes"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
