"""PDF QR stamping — overlay QR code images onto PDF pages using PyMuPDF."""

import fitz


def stamp_qr_on_pdf(
    pdf_bytes: bytes,
    qr_images: list[bytes],
    margin_inches: float = 1.0,
    qr_size_inches: float = 2.0,
) -> bytes:
    """Stamp QR code images onto each page of a PDF.

    Each QR code is placed anchored 1 inch from the bottom-right corner
    of each page. Multiple QR codes are arranged in a horizontal row.

    Args:
        pdf_bytes: Raw PDF content
        qr_images: List of QR image PNG bytes
        margin_inches: Distance from bottom-right corner
        qr_size_inches: Physical size of each QR code
    Returns:
        New PDF bytes with QR overlays
    """
    qr_pts = qr_size_inches * 72.0  # 1 inch = 72 PDF points
    margin_pts = margin_inches * 72.0

    doc = fitz.open(stream=pdf_bytes)

    for page_idx in range(doc.page_count):
        qr_img = qr_images[page_idx] if qr_images else None
        if not qr_img:
            continue

        page = doc[page_idx]
        page_w = page.rect.width
        page_h = page.rect.height

        # Bottom-right anchor
        x = page_w - margin_pts - qr_pts
        y = page_h - margin_pts - qr_pts

        page.insert_image(
            fitz.Rect(x, y, x + qr_pts, y + qr_pts),
            stream=qr_img,
            width=qr_pts,
            height=qr_pts,
        )

    return doc.tobytes()
