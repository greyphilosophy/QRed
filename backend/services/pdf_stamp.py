"""PDF Sealing Pipeline — read PDF, extract text, stamp QR seals onto pages."""

import hashlib
import io
import logging
from pathlib import Path
from typing import Optional

import fitz  # PyMuPDF
import qrcode

from backend.models import SealGenerationResult
from backend.services.sealer import canonicalize_text, create_seals

logger = logging.getLogger(__name__)

QR_BORDER = 1
QR_BOX_SIZE = 4
QR_ERROR_CORRECTION = qrcode.constants.ERROR_CORRECT_M
DEFAULT_BOOTSTRAP_URL = "https://qred.org/"


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

    Every QR payload is now a self-contained https://qred.org/#data URL. If a
    document has more seal URLs than the source pages can display, additional
    seal pages are appended to carry the overflow.
    """
    if source_page_count < 1:
        raise ValueError("PDF must contain at least one page")
    if max_qr_codes < 1:
        raise ValueError("PDF page layout must fit at least one QRed payload QR")

    payload_capacity = max_qr_codes
    pages: list[list[str]] = []
    next_seal = 0

    for page_index in range(source_page_count):
        page_payloads = []
        assigned = seal_strings[next_seal:next_seal + payload_capacity]
        next_seal += len(assigned)
        if not assigned and seal_strings:
            assigned = [seal_strings[page_index % len(seal_strings)]]
        pages.append(page_payloads + assigned)

    while next_seal < len(seal_strings):
        assigned = seal_strings[next_seal:next_seal + payload_capacity]
        next_seal += len(assigned)
        pages.append(assigned)

    return pages




def page_seal_document_id(merkle_root: str, page_text: str, seal_occurrence_number: int) -> str:
    """Return a unique QR transport id for one independently reconstructable page payload."""
    grouping_material = f"{merkle_root}{page_content_hash(page_text)}{seal_occurrence_number}"
    return hashlib.sha256(grouping_material.encode("ascii")).hexdigest()


def page_content_hash(page_text: str) -> str:
    """Return a stable SHA-256 hash for a page's canonical certified text."""
    return hashlib.sha256(canonicalize_text(page_text).encode("utf-8")).hexdigest()


def document_merkle_root(page_texts: list[str]) -> str:
    """Return a Merkle-style root over the ordered page content hashes."""
    leaves = [page_content_hash(page_text) for page_text in page_texts]
    if not leaves:
        return hashlib.sha256(b"").hexdigest()

    level = leaves
    while len(level) > 1:
        next_level = []
        for index in range(0, len(level), 2):
            left = level[index]
            right = level[index + 1] if index + 1 < len(level) else left
            next_level.append(hashlib.sha256(f"{left}{right}".encode("ascii")).hexdigest())
        level = next_level
    return level[0]


def page_integrity_text(
    page_text: str,
    merkle_root: str,
) -> str:
    """Wrap page text with signed integrity metadata that binds pages together."""
    canonical_page_text = canonicalize_text(page_text)
    return "\n".join([
        "QRed PDF page integrity",
        f"Page SHA256: {page_content_hash(page_text)}",
        f"Document Merkle Root: {merkle_root}",
        "",
        canonical_page_text,
    ])


def create_page_seal_results(
    pdf_path: str,
    issuer: str,
    private_key: str,
    public_key: str,
    document_id: Optional[str] = None,
    bootstrap_url: str = DEFAULT_BOOTSTRAP_URL,
    encoding_strategy: str = "automatic",
) -> tuple[str, list[SealGenerationResult]]:
    """Create independent seal results for each PDF page's extracted text."""
    doc = fitz.open(pdf_path)
    try:
        page_count = len(doc)
    finally:
        doc.close()

    page_texts = [extract_text_from_pdf(pdf_path, page_index) for page_index in range(page_count)]
    # PDF page seals use the content-derived Merkle root as their public
    # document identifier; document_id is kept for API compatibility only.
    merkle_root = document_merkle_root(page_texts)

    page_results = []
    for page_index, page_text in enumerate(page_texts):
        page_results.append(
            create_seals(
                document_text=page_integrity_text(page_text, merkle_root),
                issuer=issuer,
                private_key=private_key,
                public_key=public_key,
                document_id=page_seal_document_id(merkle_root, page_text, page_index),
                bootstrap_url=bootstrap_url,
                encoding_strategy=encoding_strategy,
            )
        )
    return merkle_root, page_results

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



def stamp_page_seals_on_pdf(
    input_pdf: str,
    output_pdf: str,
    page_results: list[SealGenerationResult],
    layout: dict | None = None,
) -> str:
    """Stamp each source page with QR seals for that page's own text."""
    layout = layout or {}
    doc = fitz.open(input_pdf)
    try:
        if len(doc) != len(page_results):
            raise ValueError("Page seal count must match PDF page count")

        for page, seal_result in zip(doc, page_results):
            qr_payloads = [chunk.encode() for chunk in seal_result.chunks]
            max_qr_codes = max_qr_codes_per_row(page.rect.width, layout)
            if len(qr_payloads) > max_qr_codes:
                raise ValueError("PDF page layout cannot fit all QRed seals for a page")
            insert_qr_row(page, qr_payloads, layout)

        doc.save(output_pdf)
        logger.info("Stamped page-specific seals on %d pages of %s", len(doc), input_pdf)
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
    encoding_strategy: str = "automatic",
) -> dict:
    """Full pipeline: read PDF → sign → generate seals → stamp onto PDF."""
    if output_path is None:
        input_path = Path(pdf_path)
        output_path = str(input_path.with_name(f"{input_path.stem}.sealed{input_path.suffix}"))

    base_document_id, page_results = create_page_seal_results(
        pdf_path=pdf_path,
        issuer=issuer,
        private_key=private_key,
        public_key=public_key,
        document_id=document_id,
        bootstrap_url=bootstrap_url,
        encoding_strategy=encoding_strategy,
    )
    stamp_page_seals_on_pdf(pdf_path, output_path, page_results, layout or {})

    page_seal_strings = [[chunk.encode() for chunk in result.chunks] for result in page_results]
    seal_strings = [seal for page_seals in page_seal_strings for seal in page_seals]
    first_result = page_results[0]

    return {
        "document_id": base_document_id,
        "issuer": first_result.issuer,
        "key_id": first_result.key_id,
        "bootstrap_url": first_result.bootstrap_url,
        "output_path": output_path,
        "total_seals": len(seal_strings),
        "seal_strings": seal_strings,
        "page_seal_strings": page_seal_strings,
        "encoding": first_result.encoding,
        "encoding_strategy": first_result.encoding_strategy,
        "selected_recipe": first_result.selected_recipe,
        "estimated_qr_count": first_result.estimated_qr_count,
        "compression_savings_pct": first_result.compression_savings_pct,
        "candidate_reports": first_result.candidate_reports,
    }
