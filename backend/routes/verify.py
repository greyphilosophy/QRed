"""QRed Verification API routes.

Accepts QRed seal strings and optionally the issuer's public key. 
If no public key is provided, the payload's embedded public_key is used
(self-contained verification — ideal for mobile where round-trips are expensive).
"""

from fastapi import APIRouter
from pydantic import BaseModel, Field

from backend.services.verifier import reconstruct_and_verify

router = APIRouter()


class VerifyRequest(BaseModel):
    """Request body for verifying QRed seals."""
    seals: list[str] = Field(..., min_length=1, description="QRed seal strings")
    public_key: str = Field("", description="Issuer's Ed25519 public key (optional — embedded key used if absent)")


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
    """Verify QRed seals.

    If public_key is provided, it overrides the embedded key.
    If omitted, the verifier uses the public_key embedded in the payload
    (self-contained verification, optimized for mobile).
    """
    pk = request.public_key if request.public_key else None
    result = reconstruct_and_verify(request.seals, pk)
    return VerifyResponse(
        status=result.get("status", "ERROR"),
        document_id=result.get("document_id", ""),
        error_message=result.get("error_message", ""),
        issuer=result.get("issuer", ""),
        timestamp=result.get("timestamp", ""),
        content=result.get("content", ""),
    )
