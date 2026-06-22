"""Demo keypair helpers for local demos."""

from fastapi import APIRouter

from backend.crypto import generate_keypair

router = APIRouter()


@router.get("/keys/demo")
def demo_keypair() -> dict:
    """Return an ephemeral Ed25519 keypair for local demonstrations."""
    return generate_keypair()
