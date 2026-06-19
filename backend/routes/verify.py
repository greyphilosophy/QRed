"""QRed Verification API routes."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.services.verifier import reconstruct_and_verify

router = APIRouter()


class VerifyRequest(BaseModel):
    """Request body for verifying QRed seals."""
    seals: list[str] = Field(..., min_length=1, description="QRed seal strings")
    expected_public_key: str = Field("", description="Optional expected public key")


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
    """Verify QRed seals and return the verification result."""
    result = reconstruct_and_verify(request.seals, request.expected_public_key or None)
    return VerifyResponse(
        status=result.get("status", "ERROR"),
        document_id=result.get("document_id", ""),
        error_message=result.get("error_message", ""),
        issuer=result.get("issuer", ""),
        timestamp=result.get("timestamp", ""),
        content=result.get("content", ""),
    )
