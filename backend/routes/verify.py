"""QRed Verification API routes.

Accepts QRed seal strings and the issuer's public key (required for trusted
verification). Also provides a self-contained verification endpoint that uses
the payload's embedded public_key, explicitly labeling the result as SELF_SIGNED
to distinguish it from registry-trusted verification.
"""

from fastapi import APIRouter
from pydantic import BaseModel, Field

from backend.services.verifier import reconstruct_and_verify

router = APIRouter()


class VerifyRequest(BaseModel):
    """Request body for trusted verification — public_key is required."""
    seals: list[str] = Field(..., min_length=1, description="QRed seal strings")
    public_key: str = Field(..., min_length=1, description="Issuer's Ed25519 public key (from trusted registry)")


class SelfContainedVerifyRequest(BaseModel):
    """Request body for self-contained (embedded-key) verification.
    
    Only requires seals — the embedded public key in the payload is used.
    """
    seals: list[str] = Field(..., min_length=1, description="QRed seal strings")


class VerifyResponse(BaseModel):
    """Response containing verification results."""
    status: str
    document_id: str = ""
    error_message: str = ""
    issuer: str = ""
    timestamp: str = ""
    content: str = ""


class SelfContainedVerifyResponse(BaseModel):
    """Response for self-contained (embedded-key) verification.
    
    Status is SELF_SIGNED to indicate that integrity is verified but the issuer
    identity is only as trustworthy as the embedded public key.
    """
    status: str
    verification_method: str = "self_signed"
    document_id: str = ""
    error_message: str = ""
    issuer: str = ""
    timestamp: str = ""
    content: str = ""
    warning: str = "Issuer identity is self-signed — pin to a trusted key fingerprint for full authenticity"


@router.post("/verify", response_model=VerifyResponse)
def verify_seals(request: VerifyRequest) -> VerifyResponse:
    """Verify QRed seals using a trusted issuer public key.

    This is the primary verification endpoint. The public key should be obtained
    from a trusted issuer key registry matching the issuer_id in the payload.
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


@router.post("/verify/self-contained", response_model=SelfContainedVerifyResponse)
def verify_self_contained(request: SelfContainedVerifyRequest) -> SelfContainedVerifyResponse:
    """Verify QRed seals using the embedded public key (self-signed integrity).
    
    This endpoint uses the public_key embedded in the payload rather than a
    trusted registry lookup. The result is labeled SELF_SIGNED to indicate
    that content integrity is verified but issuer authenticity depends on
    pinning the embedded key fingerprint.
    
    Use this for mobile/offline verification where a registry round-trip is
    expensive. For full trust, compare the embedded key fingerprint against
    a trusted registry result.
    """
    result = reconstruct_and_verify(request.seals, "")
    
    status_map = {
        "VALID": "SELF_SIGNED",
        "INVALID": "SELF_SIGNED_INVALID",
        "INCOMPLETE": "SELF_SIGNED_INCOMPLETE",
        "ERROR": "ERROR",
    }
    mapped_status = status_map.get(result.get("status"), "ERROR")
    
    warning = ""
    if mapped_status.startswith("SELF_SIGNED"):
        warning = "Issuer identity is self-signed — compare the embedded public key fingerprint against a trusted registry for full authenticity"
    
    return SelfContainedVerifyResponse(
        status=mapped_status,
        verification_method="self_signed",
        document_id=result.get("document_id", ""),
        error_message=result.get("error_message", ""),
        issuer=result.get("issuer", ""),
        timestamp=result.get("timestamp", ""),
        content=result.get("content", ""),
        warning=warning,
    )
