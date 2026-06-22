"""PDF Sealing Pipeline — read PDF, extract text, stamp QR seals onto pages."""

import io
import logging
from pathlib import Path
from typing import Optional

import fitz  # PyMuPDF
import qrcode
from PIL import Image

from backend.models import SealGenerationResult
from backend.services.sealer import create_seals

logger = logging.getLogger(__name__)

QR_BORDER = 1
QR_BOX_SIZE = 4
QR_ERROR_CORRECTION = qrcode.constants.ERROR_CORRECT_M
DEFAULT_BOOTSTRAP_URL = "https://qred.org/verify.htm"


def extract_text_from_pdf(pdf_path: str, page_number: Optional[int] = None) -> str:
    """Extract a deterministic text representation from a PDF file."""
    doc = fitz.open(pdf_path)
    try:
        if page_number is not None:
            page = doc.load_page(page_number)
            return page.get_text("text")
        texts = [p.get_text("text") for p in doc]
        return "\n\n".join(texts)
    finally:
        doc.close()


def generate_qr_bytes(seal_string: str) -> bytes:
    """Generate a QR code for a seal string and return compact PNG bytes."""
    qr = qrcode.QRCode(
        version=None,
        error_correction=QR_ERROR_CORRECTION,
        box_size=QR_BOX_SIZE,
        border=QR_BORDER,
    )
    qr.add_data(seal_string)
    qr.make(fit=True)
    img = qr.make_image().convert("1")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf.getvalue()


def seals_for_page(seal_strings: list[str], page_index: int, page_count: int) -> list[str]:
    """Return the payload seal strings assigned to one page.

    The assignment is deterministic and pure: seals are striped across pages,
    with a fallback that repeats one seal per page for small documents so every
    page visibly contains a payload QR for demos.
    """
    assigned = [seal for index, seal in enumerate(seal_strings) if index % page_count == page_index]
    if assigned or not seal_strings:
        return assigned
    return [seal_strings[page_index % len(seal_strings)]]


def page_stamp_items(seal_strings: list[str], bootstrap_url: str, page_index: int, page_count: int) -> list[str]:
    """Build the QR payloads that should be stamped on a page."""
    return [bootstrap_url] + seals_for_page(seal_strings, page_index, page_count)


def insert_qr_row(page: fitz.Page, qr_payloads: list[str], layout: dict) -> None:
    """Insert QR payloads in a bottom row on a PDF page."""
    qr_size = layout.get("size", 96)
    spacing = layout.get("spacing", qr_size + 16)
    margin = layout.get("margin", 32)
    max_per_page = max(1, int((page.rect.width - (2 * margin) + 16) // spacing))
    for i, payload in enumerate(qr_payloads[:max_per_page]):
        png_bytes = generate_qr_bytes(payload)
        x_pos = margin + i * spacing
        y_pos = page.rect.height - margin - qr_size
        rect = fitz.Rect(x_pos, y_pos, x_pos + qr_size, y_pos + qr_size)
        page.insert_image(rect, stream=png_bytes)


def stamp_seals_on_pdf(
    input_pdf: str,
    output_pdf: str,
    seal_result: SealGenerationResult,
    layout: dict | None = None,
) -> str:
    """Stamp bootstrap and payload QR seal codes onto every PDF page."""
    layout = layout or {}
    seal_strings = [chunk.encode() for chunk in seal_result.chunks]
    if not seal_strings:
        logger.warning("No seals to stamp on PDF %s", input_pdf)
        return output_pdf

    doc = fitz.open(input_pdf)
    try:
        page_count = len(doc)
        for page_index, page in enumerate(doc):
            payloads = page_stamp_items(seal_strings, seal_result.bootstrap_url, page_index, page_count)
            insert_qr_row(page, payloads, layout)
        doc.save(output_pdf)
        logger.info("Stamped %d payload seals across %d pages of %s", len(seal_strings), page_count, input_pdf)
        return output_pdf
    finally:
        doc.close()


def seal_pdf(
    pdf_path: str,
    issuer: str,
    private_key: str,
    public_key: str,
    output_path: Optional[str] = None,
    document_id: Optional[str] = None,
    layout: dict | None = None,
    bootstrap_url: str = DEFAULT_BOOTSTRAP_URL,
) -> dict:
    """Full pipeline: read PDF → sign → generate seals → stamp onto PDF."""
    if output_path is None:
        input_path = Path(pdf_path)
        output_path = str(input_path.with_name(f"{input_path.stem}.sealed{input_path.suffix}"))

    text = extract_text_from_pdf(pdf_path)
    result = create_seals(
        document_text=text,
        issuer=issuer,
        private_key=private_key,
        public_key=public_key,
        document_id=document_id,
        bootstrap_url=bootstrap_url,
    )
    stamp_seals_on_pdf(pdf_path, output_path, result, layout or {})

    return {
        "document_id": result.document_id,
        "issuer": result.issuer,
        "key_id": result.key_id,
        "bootstrap_url": result.bootstrap_url,
        "output_path": output_path,
        "total_seals": result.total_chunks,
        "seal_strings": [c.encode() for c in result.chunks],
    }
