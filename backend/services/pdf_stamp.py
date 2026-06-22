"""PDF Sealing Pipeline — read PDF, extract text, stamp QR seals onto pages."""

import io
import logging
from pathlib import Path
from typing import Optional

import fitz  # PyMuPDF
import qrcode

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


def max_qr_codes_per_row(page_width: float, layout: dict) -> int:
    """Return how many QR codes fit in one row for the page width/layout."""
    qr_size = layout.get("size", 96)
    spacing = layout.get("spacing", qr_size + 16)
    margin = layout.get("margin", 32)
    usable_width = max(qr_size, page_width - (2 * margin))
    return max(1, int((usable_width + (spacing - qr_size)) // spacing))


def planned_page_payloads(
    seal_strings: list[str],
    bootstrap_url: str,
    source_page_count: int,
    max_qr_codes: int,
) -> list[list[str]]:
    """Plan QR payloads for source and appended pages without dropping chunks.

    Every source page receives the bootstrap QR and at least one payload QR when
    payload seals exist. If a document has more seals than the source pages can
    display, additional seal pages are appended to carry the overflow.
    """
    if source_page_count < 1:
        raise ValueError("PDF must contain at least one page")
    if max_qr_codes < 2:
        raise ValueError("PDF page layout must fit at least one bootstrap QR and one payload QR")

    payload_capacity = max_qr_codes - 1
    pages: list[list[str]] = []
    next_seal = 0

    for page_index in range(source_page_count):
        page_payloads = [bootstrap_url]
        assigned = seal_strings[next_seal:next_seal + payload_capacity]
        next_seal += len(assigned)
        if not assigned and seal_strings:
            assigned = [seal_strings[page_index % len(seal_strings)]]
        pages.append(page_payloads + assigned)

    while next_seal < len(seal_strings):
        assigned = seal_strings[next_seal:next_seal + payload_capacity]
        next_seal += len(assigned)
        pages.append([bootstrap_url] + assigned)

    return pages


def insert_qr_row(page: fitz.Page, qr_payloads: list[str], layout: dict) -> None:
    """Insert QR payloads in a bottom row on a PDF page."""
    qr_size = layout.get("size", 96)
    spacing = layout.get("spacing", qr_size + 16)
    margin = layout.get("margin", 32)
    for i, payload in enumerate(qr_payloads):
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
    """Stamp bootstrap and payload QR seal codes onto every PDF page.

    Payload chunks are never silently dropped. When the source document cannot
    fit all payload QRs, this appends extra seal pages that contain the overflow.
    """
    layout = layout or {}
    seal_strings = [chunk.encode() for chunk in seal_result.chunks]
    if not seal_strings:
        logger.warning("No seals to stamp on PDF %s", input_pdf)
        return output_pdf

    doc = fitz.open(input_pdf)
    try:
        source_page_count = len(doc)
        first_page = doc[0]
        max_qr_codes = max_qr_codes_per_row(first_page.rect.width, layout)
        page_payloads = planned_page_payloads(
            seal_strings,
            seal_result.bootstrap_url,
            source_page_count,
            max_qr_codes,
        )

        while len(doc) < len(page_payloads):
            doc.new_page(width=first_page.rect.width, height=first_page.rect.height)

        for page, payloads in zip(doc, page_payloads):
            insert_qr_row(page, payloads, layout)

        doc.save(output_pdf)
        logger.info(
            "Stamped %d payload seals across %d source pages and %d total pages of %s",
            len(seal_strings),
            source_page_count,
            len(doc),
            input_pdf,
        )
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
