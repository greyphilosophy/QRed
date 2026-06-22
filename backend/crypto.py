"""Ed25519 public-key cryptography for QRed.

Uses the Ed25519 keypair so that:
  - The private key signs documents (only the issuer knows it).
  - The public key verifies signatures (anyone can verify).
  - Verification != ability to forge.

The verifier uses an explicitly supplied public key or resolves one from a
trusted issuer key registry using issuer_id + key_id. Payload-embedded public
keys are not trusted for signature verification.
"""

import base64
import hashlib

from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
)


def compute_key_id(public_key_b64: str) -> str:
    """Derive a stable key_id from a base64-encoded Ed25519 public key.
    
    Returns the first 16 hex characters of SHA-256(raw_public_key_bytes).
    
    Used by both the sealer and the issuer registry to ensure consistency.
    """
    pub_bytes = base64.urlsafe_b64decode(public_key_b64)
    return hashlib.sha256(pub_bytes).hexdigest()[:16]


def generate_keypair() -> dict:
    """Generate an Ed25519 keypair and return as base64 strings.
    
    Returns:
        {"private_key": base64 string, "public_key": base64 string, "key_id": hex string}
    
    The key_id is a stable identifier derived from the public key bytes,
    useful for looking up the correct public key in an issuer registry.
    """
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key()
    
    priv_bytes = private_key.private_bytes(
        encoding=Encoding.Raw,
        format=PrivateFormat.Raw,
        encryption_algorithm=NoEncryption(),
    )
    pub_bytes = public_key.public_bytes(
        encoding=Encoding.Raw,
        format=PublicFormat.Raw,
    )
    
    pub_b64 = base64.urlsafe_b64encode(pub_bytes).decode()
    key_id = compute_key_id(pub_b64)
    
    return {
        "private_key": base64.urlsafe_b64encode(priv_bytes).decode(),
        "public_key": pub_b64,
        "key_id": key_id,
    }


def sign(content: str, private_key_b64: str) -> str:
    """Sign content with an Ed25519 private key. Returns base64 signature."""
    raw = base64.urlsafe_b64decode(private_key_b64)
    key = Ed25519PrivateKey.from_private_bytes(raw)
    signature = key.sign(content.encode("utf-8"))
    return base64.urlsafe_b64encode(signature).decode()


def verify(content: str, signature_b64: str, public_key_b64: str) -> bool:
    """Verify content against a signature using an Ed25519 public key.
    
    Returns True if the signature is valid, False otherwise.
    """
    raw = base64.urlsafe_b64decode(public_key_b64)
    key = Ed25519PublicKey.from_public_bytes(raw)
    signature = base64.urlsafe_b64decode(signature_b64)
    try:
        key.verify(signature, content.encode("utf-8"))
        return True
    except Exception:
        return False
