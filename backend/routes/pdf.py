"""API Routes — PDF sealing endpoints."""

import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.services.pdf_stamp import DEFAULT_BOOTSTRAP_URL, extract_text_from_pdf, seal_pdf

logger = logging.getLogger(__name__)

router = APIRouter()


class SealPdfResponse(BaseModel):
    document_id: str
    issuer: str
    key_id: str
    bootstrap_url: str
    output_path: str
    total_seals: int
    seal_strings: list[str]


def build_layout(
    layout_size: Optional[int] = None,
    layout_spacing: Optional[int] = None,
    layout_margin: Optional[int] = None,
) -> dict:
    """Build a compact layout dictionary from optional request fields."""
    layout = {}
    if layout_size is not None:
        layout["size"] = layout_size
    if layout_spacing is not None:
        layout["spacing"] = layout_spacing
    if layout_margin is not None:
        layout["margin"] = layout_margin
    return layout


def ensure_pdf_upload(upload: UploadFile) -> None:
    """Reject uploads that are not PDF files by filename or content type."""
    filename = upload.filename or ""
    content_type = upload.content_type or ""
    if not filename.lower().endswith(".pdf") and content_type != "application/pdf":
        raise HTTPException(status_code=415, detail="Upload must be a PDF file")


@router.post("/api/pdf/seal", response_model=SealPdfResponse)
def seal_pdf_endpoint(
    pdf_path: str = Query(description="Path to input PDF"),
    issuer: str = Query(...),
    private_key: str = Query(...),
    public_key: str = Query(...),
    document_id: Optional[str] = Query(default=None),
    output_path: Optional[str] = Query(default=None),
    layout_size: Optional[int] = Query(default=None),
    layout_spacing: Optional[int] = Query(default=None),
    layout_margin: Optional[int] = Query(default=None),
    bootstrap_url: str = Query(default=DEFAULT_BOOTSTRAP_URL),
):
    """Seal a PDF addressed by local path with QRed QR codes."""
    if not os.path.exists(pdf_path):
        raise HTTPException(status_code=404, detail=f"PDF not found: {pdf_path}")

    try:
        return seal_pdf(
            pdf_path=pdf_path,
            issuer=issuer,
            private_key=private_key,
            public_key=public_key,
            output_path=output_path,
            document_id=document_id,
            layout=build_layout(layout_size, layout_spacing, layout_margin),
            bootstrap_url=bootstrap_url,
        )
    except Exception as e:
        logger.exception("Error sealing PDF: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/pdf/upload-seal")
def upload_and_seal_pdf(
    file: UploadFile = File(...),
    issuer: str = Form(...),
    private_key: str = Form(...),
    public_key: str = Form(...),
    document_id: Optional[str] = Form(default=None),
    bootstrap_url: str = Form(default=DEFAULT_BOOTSTRAP_URL),
):
    """Accept a browser PDF upload and return a sealed PDF download."""
    ensure_pdf_upload(file)
    workdir = Path(tempfile.mkdtemp(prefix="qred-upload-"))
    safe_name = Path(file.filename or "document.pdf").name
    input_path = workdir / safe_name
    output_path = workdir / f"{input_path.stem}.qred-sealed.pdf"

    try:
        with input_path.open("wb") as out_file:
            shutil.copyfileobj(file.file, out_file)
        result = seal_pdf(
            pdf_path=str(input_path),
            issuer=issuer,
            private_key=private_key,
            public_key=public_key,
            output_path=str(output_path),
            document_id=document_id,
            bootstrap_url=bootstrap_url,
        )
    except Exception as e:
        logger.exception("Error sealing uploaded PDF: %s", e)
        raise HTTPException(status_code=500, detail=str(e))

    headers = {
        "X-QRed-Document-Id": result["document_id"],
        "X-QRed-Issuer": result["issuer"],
        "X-QRed-Key-Id": result["key_id"],
        "X-QRed-Total-Seals": str(result["total_seals"]),
        "X-QRed-Bootstrap-Url": result["bootstrap_url"],
    }
    return FileResponse(
        path=output_path,
        media_type="application/pdf",
        filename=output_path.name,
        headers=headers,
    )


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
