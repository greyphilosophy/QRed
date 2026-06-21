"""API Routes — PDF sealing endpoints."""

import logging
import os
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from backend.services.pdf_stamp import extract_text_from_pdf, seal_pdf

logger = logging.getLogger(__name__)

router = APIRouter()


class SealPdfRequest(BaseModel):
    issuer: str
    private_key: str
    public_key: str
    document_id: Optional[str] = None
    output_path: Optional[str] = None
    layout_page: Optional[int] = None
    layout_size: Optional[int] = None
    layout_spacing: Optional[int] = None
    layout_margin: Optional[int] = None


class SealPdfResponse(BaseModel):
    document_id: str
    issuer: str
    key_id: str
    output_path: str
    total_seals: int
    seal_strings: list[str]


@router.post("/api/pdf/seal", response_model=SealPdfResponse)
def seal_pdf_endpoint(
    pdf_path: str = Query(description="Path to input PDF"),
    issuer: str = Query(...),
    private_key: str = Query(...),
    public_key: str = Query(...),
    document_id: Optional[str] = Query(default=None),
    output_path: Optional[str] = Query(default=None),
    layout_page: Optional[int] = Query(default=None),
    layout_size: Optional[int] = Query(default=None),
    layout_spacing: Optional[int] = Query(default=None),
    layout_margin: Optional[int] = Query(default=None),
):
    """Seal a PDF with QRed QR codes.

    Extracts text from the PDF, signs it, generates QRed seal strings,
    and stamps QR codes onto the PDF.
    """
    layout = {}
    if layout_page is not None:
        layout["page"] = layout_page
    if layout_size is not None:
        layout["size"] = layout_size
    if layout_spacing is not None:
        layout["spacing"] = layout_spacing
    if layout_margin is not None:
        layout["margin"] = layout_margin

    if not os.path.exists(pdf_path):
        raise HTTPException(status_code=404, detail=f"PDF not found: {pdf_path}")

    try:
        result = seal_pdf(
            pdf_path=pdf_path,
            issuer=issuer,
            private_key=private_key,
            public_key=public_key,
            output_path=output_path,
            document_id=document_id,
            layout=layout,
        )
        return result
    except Exception as e:
        logger.exception("Error sealing PDF: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/pdf/text")
def extract_pdf_text(
    pdf_path: str = Query(description="Path to input PDF"),
    page: Optional[int] = Query(default=None, description="0-based page number"),
):
    """Extract text content from a PDF file."""
    if not os.path.exists(pdf_path):
        raise HTTPException(status_code=404, detail=f"PDF not found: {pdf_path}")

    try:
        text = extract_text_from_pdf(pdf_path, page)
        return {"path": pdf_path, "page": page, "text": text, "length": len(text)}
    except Exception as e:
        logger.exception("Error extracting PDF text: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
