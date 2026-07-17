"""Image-only PDF seal generation and verification tests.

These tests exercise the full seal pipeline (PDF stamping → seal generation →
verification) against PDFs that contain scanned-image pages but NO extractable
text streams.  They confirm that the verifier handles empty content gracefully.
"""

import io
import os
import pytest
import fitz  # PyMuPDF
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.crypto import generate_keypair
from backend.services.pdf_stamp import (
    seal_pdf,
    extract_text_from_pdf,
    create_page_seal_results,
    page_integrity_text,
    document_merkle_root,
    page_content_hash,
    page_seal_document_id,
)
from backend.services.verifier import decode_seal, reconstruct_and_verify

app = create_app()
client = TestClient(app)

KEYPAIR = generate_keypair()
ISSUER = "QRed Test"


# --- Helpers ---


def _make_image_only_pdf_bytes(page_count: int = 1) -> io.BytesIO:
    """Create an in-memory image-only PDF (no text streams)."""
    buf = io.BytesIO()
    doc = fitz.open()
    for pg in range(page_count):
        page = doc.new_page(width=612, height=792)
        shape = page.new_shape()
        shape.draw_rect(fitz.Rect(50, 50, 562, 742))
        shape.finish(color=(pg / max(1, page_count - 1), 0, 0), width=1)
        shape.commit()
    doc.save(buf)
    doc.close()
    buf.seek(0)
    return buf


def _write_tmp_pdf(page_count: int = 1, path: str | None = None) -> str:
    """Write an image-only PDF to disk and return its path."""
    if path is None:
        path = f"/tmp/_img_test_{page_count}p.pdf"
    buf = _make_image_only_pdf_bytes(page_count)
    with open(path, "wb") as f:
        f.write(buf.getvalue())
    return path


def verify_each_page(result_dict: dict) -> list[dict]:
    """Verify every page's seals independently; return list of result dicts."""
    return [
        reconstruct_and_verify(ps, expected_public_key=KEYPAIR["public_key"])
        for ps in result_dict["page_seal_strings"]
    ]


# ===========================
# FR-IMG-1: Single-page image-only PDF
# ===========================


def test_img_single_page_extracted_text_is_empty():
    """Given an image-only PDF, when text is extracted, then it is empty."""
    tmp = _write_tmp_pdf(1)
    text = extract_text_from_pdf(tmp)
    assert text == ""


def test_img_single_page_seal_generates_successfully():
    """Given an image-only PDF, when sealed, then one seal is created."""
    tmp = _write_tmp_pdf(1)
    result = seal_pdf(
        pdf_path=tmp,
        issuer=ISSUER,
        private_key=KEYPAIR["private_key"],
        public_key=KEYPAIR["public_key"],
    )
    assert result["total_seals"] >= 1
    assert len(result["seal_strings"]) == result["total_seals"]


def test_img_single_page_seal_contains_integrity_header():
    """Given an image-only PDF, when decoded, the seal txt contains integrity metadata."""
    tmp = _write_tmp_pdf(1)
    result = seal_pdf(
        pdf_path=tmp,
        issuer=ISSUER,
        private_key=KEYPAIR["private_key"],
        public_key=KEYPAIR["public_key"],
    )
    first_seal = result["seal_strings"][0]
    decoded = decode_seal(first_seal)
    assert decoded is not None
    data = decoded.get("data", "")
    assert "QRed PDF page integrity" in data
    assert "Page SHA256:" in data
    assert "Document Merkle Root:" in data


def test_img_single_page_per_page_verification_succeeds():
    """Given an image-only PDF, when verifying page-by-page, then each page is VALID."""
    tmp = _write_tmp_pdf(1)
    result = seal_pdf(
        pdf_path=tmp,
        issuer=ISSUER,
        private_key=KEYPAIR["private_key"],
        public_key=KEYPAIR["public_key"],
    )

    verifications = verify_each_page(result)
    assert len(verifications) == 1
    assert verifications[0]["status"] == "VALID"
    assert "QRed PDF page integrity" in verifications[0].get("content", "")


def test_img_single_page_page_sha256_of_empty():
    """Given an image-only PDF page, the Page SHA256 is the SHA-256 of empty string."""
    empty_hash = page_content_hash("")
    assert empty_hash == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def test_img_single_page_merkle_root_of_one_empty_page():
    """Given one empty page, the Merkle root is the leaf hash itself."""
    merkle = document_merkle_root([""])
    assert merkle == page_content_hash("")


# ===========================
# FR-IMG-2: Multi-page image-only PDF
# ===========================


def test_img_multi_page_all_pages_have_empty_text():
    """Given a 3-page image-only PDF, all pages extract to empty strings."""
    tmp = _write_tmp_pdf(3)

    for i in range(3):
        text = extract_text_from_pdf(tmp, page_number=i)
        assert text == "", f"Page {i} should have no text but got '{text}'"


def test_img_multi_page_seal_per_page_valid():
    """Given a 3-page image-only PDF, each page verifies VALID individually."""
    tmp = _write_tmp_pdf(3)
    result = seal_pdf(
        pdf_path=tmp,
        issuer=ISSUER,
        private_key=KEYPAIR["private_key"],
        public_key=KEYPAIR["public_key"],
    )
    assert result["total_seals"] == 3  # One seal per page

    verifications = verify_each_page(result)
    assert len(verifications) == 3
    for v in verifications:
        assert v["status"] == "VALID", f"Page should be valid but was {v['status']}"


def test_img_multi_page_all_together_invalid_mixed_docs():
    """Given a multi-page image-only PDF, verifying all seals together yields INVALID."""
    tmp = _write_tmp_pdf(3)
    result = seal_pdf(
        pdf_path=tmp,
        issuer=ISSUER,
        private_key=KEYPAIR["private_key"],
        public_key=KEYPAIR["public_key"],
    )

    # Per-page seals intentionally get unique document IDs (Merkle + page hash + index)
    ver_all = reconstruct_and_verify(result["seal_strings"], expected_public_key=KEYPAIR["public_key"])
    assert ver_all["status"] == "INVALID"
    assert "Mixed document IDs" in ver_all.get("error_message", "")


def test_img_multi_page_unique_doc_ids_per_page():
    """Each page of an image-only PDF gets a different document ID."""
    tmp = _write_tmp_pdf(3)
    result = seal_pdf(
        pdf_path=tmp,
        issuer=ISSUER,
        private_key=KEYPAIR["private_key"],
        public_key=KEYPAIR["public_key"],
    )

    doc_ids = []
    for ps in result["page_seal_strings"]:
        dec = decode_seal(ps[0])
        if dec:
            doc_ids.append(dec["document_id"])

    # All must be distinct
    assert len(set(doc_ids)) == len(doc_ids)


# ===========================
# FR-IMG-3: API endpoint integration tests
# ===========================


def test_img_api_seal_endpoint_returns_success():
    """When uploading an image-only PDF via /api/pdf/seal, the response is 200 OK."""
    tmp = "/tmp/_img_test_api_1p.pdf"
    _write_tmp_pdf(1, path=tmp)

    resp = client.post(
        "/api/pdf/seal",
        params={
            "pdf_path": tmp,
            "issuer": ISSUER,
            "private_key": KEYPAIR["private_key"],
            "public_key": KEYPAIR["public_key"],
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total_seals"] >= 1
    assert data["seal_strings"]


def test_img_api_seal_endpoint_validates_empty_content_in_result():
    """The seal API response for an image-only PDF shows encoding and seal info."""
    tmp = "/tmp/_img_test_api_2p.pdf"
    _write_tmp_pdf(2, path=tmp)

    resp = client.post(
        "/api/pdf/seal",
        params={
            "pdf_path": tmp,
            "issuer": ISSUER,
            "private_key": KEYPAIR["private_key"],
            "public_key": KEYPAIR["public_key"],
        },
    )
    data = resp.json()
    assert data["total_seals"] == 2


# ===========================
# FR-IMG-4: Integrity text structure
# ===========================


def test_img_integrity_text_structure_for_empty_page():
    """The integrity text for an empty page has exactly 5 lines (2 empty separator lines)."""
    empty_text = ""
    merkle = document_merkle_root([empty_text])
    integrity = page_integrity_text(empty_text, merkle)
    lines = integrity.split("\n")
    assert lines[0] == "QRed PDF page integrity"
    assert lines[1].startswith("Page SHA256:")
    assert lines[2].startswith("Document Merkle Root:")
    assert lines[3] == ""  # blank line separating header from body
    assert lines[4] == ""  # body is empty since there's no page text


def test_img_mixed_content_image_and_text_pages():
    """A hybrid PDF (some pages with text, some without) has correct per-page hashes."""
    tmp_path = "/tmp/_img_hybrid.pdf"
    try:
        doc = fitz.open()
        # Page 0: has text
        p0 = doc.new_page()
        p0.insert_text(fitz.Point(72, 72), "This is normal text.")
        # Page 1: image only (blank)
        p1 = doc.new_page()
        shape = p1.new_shape()
        shape.draw_rect(fitz.Rect(50, 50, 562, 742))
        shape.finish(color=(0.5, 0, 0), width=1)
        shape.commit()
        doc.save(tmp_path)
        doc.close()

        t0 = extract_text_from_pdf(tmp_path, page_number=0)
        t1 = extract_text_from_pdf(tmp_path, page_number=1)
        assert t0 != ""
        assert t1 == ""

        result = seal_pdf(
            pdf_path=tmp_path,
            issuer=ISSUER,
            private_key=KEYPAIR["private_key"],
            public_key=KEYPAIR["public_key"],
        )
        assert result["total_seals"] == 2

        # Both pages should verify individually
        vers = verify_each_page(result)
        for v in vers:
            assert v["status"] == "VALID"

    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)