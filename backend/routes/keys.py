"""Default keypair helpers for local demos."""

import os

from fastapi import APIRouter

from backend.crypto import compute_key_id, generate_keypair

router = APIRouter()


def default_keypair() -> dict:
    """Return configured default keys, or generate an ephemeral demo keypair."""
    private_key = os.getenv("QRED_DEFAULT_PRIVATE_KEY", "").strip()
    public_key = os.getenv("QRED_DEFAULT_PUBLIC_KEY", "").strip()

    if private_key and public_key:
        return {
            "private_key": private_key,
            "public_key": public_key,
            "key_id": compute_key_id(public_key),
            "source": "environment",
        }

    keys = generate_keypair()
    keys["source"] = "ephemeral"
    return keys


@router.get("/keys/default")
def configured_default_keypair() -> dict:
    """Return the backend-configured default keypair for browser demos."""
    return default_keypair()


@router.get("/keys/demo")
def demo_keypair() -> dict:
    """Return the default browser demo keypair.

    Kept as a compatibility alias for older frontend builds and docs.
    """
    return default_keypair()
