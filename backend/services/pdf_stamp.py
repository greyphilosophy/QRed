"""PDF Sealing Pipeline — read PDF, extract text, stamp QR seals onto pages."""

import io
import logging
from typing import Optional

# PDF reading
import fitz  # PyMuPDF

# QR code generation
import qrcode
from PIL import Image

from backend.models import SealGenerationResult
from backend.services.sealer import create_seals

logger = logging.getLogger(__name__)

# QR code appearance — keep them compact for print
QR_BORDER = 1
QR_BOX_SIZE = 4
QR_ERROR_CORRECTION = qrcode.constants.ERROR_CORRECT_M


def extract_text_from_pdf(pdf_path: str, page_number: Optional[int] = None) -> str:
    """Extract text content from a PDF file.

    Returns a single string: if page_number is None, concatenate all pages
    separated by double newlines. Otherwise, return that page's text.
    """
    doc = fitz.open(pdf_path)
    try:
        if page_number is not None:
            page = doc.load_page(page_number)
            return page.get_text("text")
        else:
            texts = [p.get_text("text") for p in doc]
            return "\n\n".join(texts)
    finally:
        doc.close()


def generate_qr_bytes(seal_string: str) -> bytes:
    """Generate a QR code for a seal string and return as compact PNG bytes."""
    qr = qrcode.QRCode(
        version=None,
        error_correction=QR_ERROR_CORRECTION,
        box_size=QR_BOX_SIZE,
        border=QR_BORDER,
    )
    qr.add_data(seal_string)
    qr.make(fit=True)
    # Use 1-bit monochrome PNG for smallest file size
    img = qr.make_image().convert("1")  # 1-bit black/white
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf.getvalue()


def stamp_seals_on_pdf(
    input_pdf: str,
    output_pdf: str,
    seal_result: SealGenerationResult,
    layout: dict = {},
) -> str:
    """Stamp QRed QR seal codes onto a PDF document.

    Args:
        input_pdf: Path to source PDF file.
        output_pdf: Output path for the sealed PDF.
        seal_result: The seal generation result containing QR-encodable chunks.
        layout: Layout config dict:
            - page: page number (0-based) to stamp on (default: last page)
            - size: QR code size in points (default: 120pt)
            - spacing: horizontal spacing between QRs in points (default: 140pt)
            - margin: margin from page edges in points (default: 40pt)

    Returns:
        The path to the output PDF.
    """
    page_num = layout.get("page", None)
    qr_size = layout.get("size", 120)  # points
    spacing = layout.get("spacing", 140)
    margin = layout.get("margin", 40)

    # Encode all seal strings
    seal_strings = [chunk.encode() for chunk in seal_result.chunks]
    total_seals = len(seal_strings)

    if not total_seals:
        logger.warning("No seals to stamp on PDF %s", input_pdf)
        return output_pdf

    # Generate QR bytes (monochrome 1-bit PNG)
    qr_pngs = [generate_qr_bytes(s) for s in seal_strings]

    doc = fitz.open(input_pdf)
    try:
        num_pages = len(doc)
        if page_num is None:
            page_num = num_pages - 1  # last page
        page = doc[page_num]
        page_rect = page.rect
        page_width = page_rect.width
        page_bottom = page_rect.height

        # Calculate layout: arrange QRs horizontally along the bottom
        total_width_needed = total_seals * spacing - spacing + qr_size

        # Center horizontally if they fit, otherwise flush left
        if total_width_needed < page_width - 2 * margin:
            start_x = (page_width - total_width_needed) / 2  # center
        else:
            start_x = margin  # flush left if they overflow

        # Y position: above the bottom margin
        y_pos = page_bottom - margin - qr_size

        # Place each QR code at its target position
        for i, png_bytes in enumerate(qr_pngs):
            x_pos = start_x + i * spacing
            rect = fitz.Rect(x_pos, y_pos, x_pos + qr_size, y_pos + qr_size)
            page.insert_image(rect, stream=png_bytes)

        # Save
        doc.save(output_pdf)
        logger.info(
            "Stamped %d QR seals on page %d of %s → %s",
            total_seals,
            page_num,
            input_pdf,
            output_pdf,
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
    layout: dict = {},
) -> dict:
    """Full pipeline: read PDF → sign → generate seals → stamp onto PDF.

    Args:
        pdf_path: Path to the input PDF.
        issuer: Issuer identifier string.
        private_key: Base64 URL-safe Ed25519 private key.
        public_key: Base64 URL-safe Ed25519 public key.
        output_path: Output PDF path (default: `{pdf_path}.sealed.pdf`).
        document_id: Optional explicit document ID.
        layout: Layout config for QR placement.

    Returns:
        Dict with document_id, output_path, total_seals, seal_strings.
    """
    if output_path is None:
        output_path = pdf_path.rsplit(".", 1)[0] + ".sealed.pdf"

    # Step 1: Extract text from PDF
    text = extract_text_from_pdf(pdf_path)
    logger.info("Extracted %d chars from %s", len(text), pdf_path)

    # Step 2: Generate seals
    result = create_seals(
        document_text=text,
        issuer=issuer,
        private_key=private_key,
        public_key=public_key,
        document_id=document_id,
    )
    logger.info("Generated %d seals for document %s", result.total_chunks, result.document_id)

    # Step 3: Stamp QR codes onto PDF
    stamp_seals_on_pdf(pdf_path, output_path, result, layout)

    return {
        "document_id": result.document_id,
        "issuer": result.issuer,
        "key_id": result.key_id,
        "output_path": output_path,
        "total_seals": result.total_chunks,
        "seal_strings": [c.encode() for c in result.chunks],
    }