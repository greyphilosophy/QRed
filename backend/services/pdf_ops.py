"""PDF text extraction — extract text from PDF pages using PyMuPDF."""

import fitz


def extract_page_text(pdf_bytes: bytes) -> list[str]:
    """Extract text from each page of a PDF.

    Args:
        pdf_bytes: Raw PDF content
    Returns:
        List of text strings, one per page
    """
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    texts = []
    for page in doc:
        text = page.get_text()
        texts.append(text)
    return texts
