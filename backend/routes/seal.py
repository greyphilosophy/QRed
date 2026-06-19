"""Seal generation API routes."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.services.sealer import create_seals

router = APIRouter()


class SealRequest(BaseModel):
    """Request body for generating QRed seals."""
    content: str = Field(..., min_length=1, description="Document text content")
    issuer: str = Field(..., min_length=1, description="Issuing authority name")
    private_key: str = Field(..., min_length=1, description="Issuer's private key")
    public_key: str = Field(..., min_length=1, description="Issuer's public key")
    document_id: str = Field("", description="Optional document ID")
    bootstrap_url: str = Field(
        "https://qred.org/verify",
        description="Bootstrap URL for verifier web app",
    )


class SealResponse(BaseModel):
    """Response containing generated QRed seals."""
    document_id: str
    bootstrap_url: str
    seals: list[str]
    total_seals: int


@router.post("/seals", response_model=SealResponse)
def generate_seals(request: SealRequest) -> SealResponse:
    """Generate QRed seals for a document.
    
    Takes a document's text content and issuer credentials, produces
    a set of QRed seal strings (QR-encoded) for printing.
    """
    result = create_seals(
        document_text=request.content,
        issuer=request.issuer,
        private_key=request.private_key,
        public_key=request.public_key,
        document_id=request.document_id or None,
        bootstrap_url=request.bootstrap_url,
    )
    return SealResponse(
        document_id=result.document_id,
        bootstrap_url=result.bootstrap_url,
        seals=[c.encode() for c in result.chunks],
        total_seals=result.total_chunks,
    )
