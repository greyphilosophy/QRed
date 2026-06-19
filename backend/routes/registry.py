"""QRed Issuer Registry API routes.

Endpoints for registering and looking up issuer public keys.

All routes use /registry paths — the app.py adds the /api prefix.
"""

from dataclasses import dataclass
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.crypto import compute_key_id
from backend.services.registry import registry

router = APIRouter()


class RegisterRequest(BaseModel):
    """Request body for registering a public key."""
    public_key: str


@router.get("/registry")
def list_registry() -> dict:
    """List all registered issuers and their keys."""
    keys = registry.list_all()
    return {
        "count": len(keys),
        "keys": [
            {
                "issuer_id": k.issuer_id,
                "key_id": k.key_id,
                "public_key": k.public_key,
                "algorithm": k.algorithm,
                "registered_at": k.registered_at,
            }
            for k in keys
        ],
    }


@router.get("/registry/{issuer_id}")
def get_issuer_keys(issuer_id: str) -> dict:
    """Get all registered keys for an issuer."""
    key_ids = registry.get_issuer_keys(issuer_id)
    return {
        "issuer_id": issuer_id,
        "key_ids": key_ids,
        "count": len(key_ids),
    }


@router.get("/registry/{issuer_id}/{key_id}")
def lookup_key(issuer_id: str, key_id: str) -> dict:
    """Look up a specific public key by (issuer_id, key_id).

    Returns the public key if found, 404 if not found or expired.
    """
    public_key = registry.lookup(issuer_id, key_id)
    if public_key:
        return {"issuer_id": issuer_id, "key_id": key_id, "public_key": public_key}
    else:
        raise HTTPException(status_code=404, detail=f"Key not found: {issuer_id}/{key_id}")


@router.post("/registry/{issuer_id}/{key_id}")
def register_key(issuer_id: str, key_id: str, body: RegisterRequest) -> dict:
    """Register a public key for an issuer.
    
    Validates that the caller-supplied key_id matches the public_key.
    """
    computed_key_id = compute_key_id(body.public_key)
    if computed_key_id != key_id:
        raise HTTPException(
            status_code=400,
            detail=f"key_id does not match public_key (expected {computed_key_id})"
        )
    registry.register(issuer_id=issuer_id, key_id=key_id, public_key=body.public_key)
    return {
        "status": "REGISTERED",
        "issuer_id": issuer_id,
        "key_id": key_id,
        "public_key": body.public_key,
    }


@router.delete("/registry/{issuer_id}/{key_id}")
def remove_key(issuer_id: str, key_id: str) -> dict:
    """Remove a key from the registry."""
    removed = registry.remove(issuer_id, key_id)
    return {
        "status": "REMOVED" if removed else "NOT_FOUND",
        "issuer_id": issuer_id,
        "key_id": key_id,
    }
