"""Seal generation API routes."""

from fastapi import APIRouter
from pydantic import BaseModel, Field

from backend.services.sealer import create_seals

router = APIRouter()


class SealRequest(BaseModel):
    content: str = Field(..., min_length=1, description="Document text content")
    issuer: str = Field(..., min_length=1, description="Issuing authority name")
    private_key: str = Field(..., min_length=1, description="Issuer's Ed25519 private key")
    public_key: str = Field(..., min_length=1, description="Issuer's Ed25519 public key")
    document_id: str = Field("", description="Optional document ID")
    bootstrap_url: str = Field(
        "https://qred.org/verify/v1",
        description="Bootstrap URL for verifier web app (versioned)",
    )


class SealResponse(BaseModel):
    document_id: str
    bootstrap_url: str
    seals: list[str]
    total_seals: int
    public_key: str = Field(description="Issuer's public key for verification")
    issuer: str = Field(description="Issuing authority")


@router.post("/seals", response_model=SealResponse)
def generate_seals(request: SealRequest) -> SealResponse:
    """Generate QRed seals for a document.

    Takes a document's text content and issuer credentials, produces
    a set of QRed seal strings (QR-encoded) for printing.

    The response includes the public key for verification.
    In production, the verifier looks up the public key from a trusted
    issuer registry using the issuer_id + key_id.
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
        public_key=request.public_key,
        issuer=request.issuer,
    )
