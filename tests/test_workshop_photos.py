"""Offline acceptance tests for the printable fictional workshop documents."""
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

import pytest
from playwright.sync_api import expect

from browser_helpers import OfflineNetworkGuard, prepare_text_for_offline, wait_for_offline_resources
from test_photo_verification import review_differences


FIXTURES = Path(__file__).parent / "fixtures" / "workshop"
GOLDEN = json.loads((FIXTURES / "expected.json").read_text())
CASES = [
    ("statement-2-straight", "statement-2", "/"),
    ("changed-2-straight", "statement-2", "/verify.htm"),
    ("statement-2-oblique", "statement-2", "/verify.htm"),
    ("lot-register-straight", "lot-register", "/"),
    ("statement-1-straight", "statement-1", "/"),
    ("statement-1-straight", "statement-1", "/verify.htm"),
    ("lot-register-oblique", "lot-register", "/"),
    ("lot-register-oblique", "lot-register", "/verify.htm"),
]


def test_workshop_printed_edit_is_one_digit():
    def printed(filename):
        return subprocess.check_output(["pdftotext", "-layout", FIXTURES / filename, "-"], text=True)

    original = printed("Workshop_Statement.pdf")
    assert original.count("2037") == 1
    assert printed("Workshop_Statement_Changed.pdf") == original.replace("2037", "2032")


# Observe the real worker's final response. The verifier still authenticates it normally.
OBSERVE_SEALS = """() => {
    window.workshopReads = [];
    window.Worker = class extends Worker {
        constructor(...args) {
            super(...args);
            this.addEventListener('message', ({data}) => {
                const action = data?.action;
                if (action?.status === 'found') window.workshopReads.push(action.text);
                if (action?.status === 'found-multiple') window.workshopReads.push(...action.texts);
            });
        }
    };
}"""


@pytest.mark.parametrize(("photo", "document_page", "route"), CASES,
                         ids=[c[0] + ("-standalone" if c[2] != "/" else "-home") for c in CASES])
def test_workshop_photo(browser, photo, document_page, route):
    base = os.environ.get("QRED_BASE_URL", "http://localhost:3000")
    key = FIXTURES / "demo-public-key.txt"
    expected = GOLDEN[document_page]
    context = browser.new_context(is_mobile=True, has_touch=True, viewport={"width": 390, "height": 844})
    try:
        guard = OfflineNetworkGuard(context, base)
        context.route("**/api/keys/default", lambda r: r.fulfill(json={"public_key": key.read_text().strip()}))
        page = context.new_page()
        page.goto(base + route, wait_until="networkidle")
        if route == "/verify.htm":
            page.locator("#publicKeyFileInput").set_input_files(key)
        prepare_text_for_offline(page)
        wait_for_offline_resources(page, photo=True)
        page.evaluate(OBSERVE_SEALS)
        guard.block()
        picker = page.locator("#qr-image" if route == "/" else "#pagePhotoInput")
        picker.set_input_files(FIXTURES / "photos" / f"{photo}.jpg")
        title = f"Review Page {expected['page']} of {expected['pages']}"
        review = page.get_by_role("region", name=title, exact=True)
        feedback = page.get_by_text(re.compile(r"That code opens qred\.org|No readable seal found|reached its time limit"))
        expect(review.or_(feedback).first).to_be_visible(timeout=75000)
        assert review.is_visible(), feedback.first.inner_text()
        expect(review.get_by_role("heading", name=re.compile("Seal: authenticated"))).to_be_visible()
        texts = page.evaluate("Array.from(new Set(window.workshopReads))")
        assert sorted(hashlib.sha256(text.encode()).hexdigest() for text in texts) == expected["sealDigests"]
        if photo in ("statement-2-straight", "changed-2-straight"):
            if route == "/verify.htm":
                page.get_by_role("button", name="Check this page now", exact=True).click()
            check_printed_year(review, changed=photo == "changed-2-straight")
        guard.assert_quiet()
    finally:
        context.close()


def check_printed_year(review, *, changed):
    expect(review.locator(".page-check-status.queued, .page-check-status.reading")).to_have_count(0, timeout=90000)
    review.get_by_label("Show matching words too").check()
    matched = review.get_by_role("button", name="Matching text: 2037", exact=True)
    if not changed:
        expect(matched).to_have_count(1)
        return
    expect(matched).to_have_count(0)
    year_readings = []
    for card in review_differences(review):
        signed = next((line for line in card.splitlines() if line.startswith("Sealed text:")), "")
        observed = next((line for line in card.splitlines() if line.startswith("Photo reading:")), "")
        if re.search(r"\b2037\b", signed):
            year_readings.append(observed)
    assert any(re.search(r"\b2032\b", reading) for reading in year_readings), year_readings
    assert all(not re.search(r"\b2037\b", reading) for reading in year_readings)
