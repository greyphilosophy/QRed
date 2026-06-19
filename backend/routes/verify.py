"""QRed Verification API routes.

Accepts QRed seal strings and the issuer's public key (obtained from a trusted
issuer registry), reconstructs the payload, verifies the Ed25519 signature,
and returns the verification result.
"""

from fastapi import APIRouter
from pydantic import BaseModel, Field

from backend.services.verifier import reconstruct_and_verify

router = APIRouter()


class VerifyRequest(BaseModel):
    """Request body for verifying QRed seals."""
    seals: list[str] = Field(..., min_length=1, description="QRed seal strings")
    public_key: str = Field(..., description="Issuer's Ed25519 public key (from trusted registry)")


class VerifyResponse(BaseModel):
    """Response containing verification results."""
    status: str
    document_id: str = ""
    error_message: str = ""
    issuer: str = ""
    timestamp: str = ""
    content: str = ""


@router.post("/verify", response_model=VerifyResponse)
def verify_seals(request: VerifyRequest) -> VerifyResponse:
    """Verify QRed seals using the issuer's public key.

    The public key should be obtained from a trusted issuer key registry
    matching the issuer_id in the payload.
    """
    result = reconstruct_and_verify(request.seals, request.public_key)
    return VerifyResponse(
        status=result.get("status", "ERROR"),
        document_id=result.get("document_id", ""),
        error_message=result.get("error_message", ""),
        issuer=result.get("issuer", ""),
        timestamp=result.get("timestamp", ""),
        content=result.get("content", ""),
    )
