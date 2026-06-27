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
    encoding_strategy: str = Field("automatic", description="Text encoding strategy")
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
    encoding_strategy: str = Field(description="Requested encoding strategy")
    selected_recipe: str = Field(description="Selected text recipe")
    estimated_qr_count: int = Field(description="Estimated QR count for the chosen encoding")
    compression_savings_pct: int = Field(description="Estimated percentage savings versus plaintext")
    candidate_reports: list[dict] = Field(default_factory=list, description="Candidate evaluation reports")


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
        encoding_strategy=request.encoding_strategy,
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
        encoding_strategy=result.encoding_strategy,
        selected_recipe=result.selected_recipe,
        estimated_qr_count=result.estimated_qr_count,
        compression_savings_pct=result.compression_savings_pct,
        candidate_reports=result.candidate_reports,
    )
