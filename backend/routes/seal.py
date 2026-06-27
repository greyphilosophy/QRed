"""Seal generation API routes."""

from fastapi import APIRouter
from pydantic import BaseModel, Field

from backend.services.sealer import DEFAULT_BOOTSTRAP_URL, create_seals

router = APIRouter()


class SealRequest(BaseModel):
    content: str = Field(..., min_length=1, description="Document text content")
    issuer: str = Field(..., min_length=1, description="Issuing authority name")
    private_key: str = Field(..., min_length=1, description="Issuer's Ed25519 private key")
    public_key: str = Field(..., min_length=1, description="Issuer's Ed25519 public key")
    document_id: str = Field("", description="Optional document ID")
    bootstrap_url: str = Field(
        DEFAULT_BOOTSTRAP_URL,
        description="Bootstrap URL for production verifier web app",
    )


class SealResponse(BaseModel):
    document_id: str
    bootstrap_url: str
    seals: list[str]
    total_seals: int
    key_id: str = Field(description="Stable key identifier for registry lookup")
    issuer: str = Field(description="Issuing authority")
    encoding: str = Field(description="Chosen QR payload encoding")


@router.post("/seals", response_model=SealResponse)
def generate_seals(request: SealRequest) -> SealResponse:
    """Generate QRed seals for a document.

    Takes a document's text content and issuer credentials, produces
    a set of QRed seal strings (QR-encoded) for printing.

    The response includes the key_id for registry-based verification.
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
        key_id=result.key_id,
        issuer=result.issuer,
        encoding=result.encoding,
    )
