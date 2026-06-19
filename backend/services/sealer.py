"""QRed Sealer — canonicalize, sign, compress, chunk, and encode documents into QR seals."""

import base64
import gzip
import hashlib
import hmac
import json
import uuid
from dataclasses import replace
from datetime import datetime, timezone
from typing import Optional

from backend.models import DocumentPayload, QRedChunk, SealGenerationResult


def generate_document_id() -> str:
    """Generate a unique document ID."""
    return f"DOC-{uuid.uuid4().hex[:12].upper()}"


def canonicalize_text(text: str) -> str:
    """Create a canonical text representation of document content.
    
    Rules:
    - Normalize line endings to \n
    - Collapse multiple blank lines to one
    - Strip trailing whitespace per line
    - Strip leading/trailing whitespace from the whole document
    - Preserve internal content
    """
    lines = text.split("\n")
    lines = [line.rstrip() for line in lines]
    # Collapse multiple empty lines
    collapsed = []
    prev_empty = False
    for line in lines:
        if not line:
            if not prev_empty:
                collapsed.append(line)
            prev_empty = True
        else:
            collapsed.append(line)
            prev_empty = False
    # Strip leading/trailing empty lines
    while collapsed and not collapsed[0]:
        collapsed.pop(0)
    while collapsed and not collapsed[-1]:
        collapsed.pop()
    return "\n".join(collapsed)


def compute_signature(content: str, key: str) -> str:
    """Compute a digital signature over content using the issuer's key.
    
    Uses HMAC-SHA256 for the reference implementation.
    The signing key is embedded in the payload and used for verification.
    In production, use actual Ed25519 via `cryptography` or `pynacl`.
    """
    msg_hash = hashlib.sha256(content.encode("utf-8")).digest()
    key_bytes = key.encode("utf-8")
    sig = hmac.new(key_bytes, msg_hash, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(sig).decode("utf-8")


def verify_signature(content: str, signature: str, key: str) -> bool:
    """Verify a digital signature against content using the signing key."""
    expected = compute_signature(content, key)
    return base64.urlsafe_b64decode(signature) == base64.urlsafe_b64decode(expected)


def compress_payload(payload_json: str) -> str:
    """Compress a JSON payload and return a base64-encoded string."""
    compressed = gzip.compress(payload_json.encode("utf-8"))
    return base64.urlsafe_b64encode(compressed).decode("utf-8")


def decompress_payload(compressed_str: str) -> str:
    """Decompress a base64-encoded gzip payload back to JSON string."""
    compressed = base64.urlsafe_b64decode(compressed_str)
    decompressed = gzip.decompress(compressed)
    return decompressed.decode("utf-8")


def split_into_chunks(data: str, chunk_size: int = 200) -> list[str]:
    """Split compressed payload data into fixed-size chunks.
    
    Each chunk is approximately `chunk_size` characters of the base64 data.
    """
    chunks = []
    total_chunks = max(1, (len(data) + chunk_size - 1) // chunk_size)
    for i in range(total_chunks):
        start = i * chunk_size
        end = start + chunk_size
        chunks.append(data[start:end])
    return chunks


def create_seals(
    document_text: str,
    issuer: str,
    private_key: str,
    public_key: str,
    document_id: Optional[str] = None,
    bootstrap_url: str = "https://qred.org/verify",
) -> SealGenerationResult:
    """Create QRed seals for a document.
    
    Workflow:
    1. Canonicalize document text
    2. Create signed payload (signed with private key)
    3. Compress payload
    4. Split into chunks
    5. Encode as QRed chunk strings
    
    The private key is embedded in the payload so the verifier can
    use the same key for re-signing and verification.
    """
    # Step 1: Canonicalize
    canonical = canonicalize_text(document_text)
    
    # Step 2: Create document ID if not provided
    if not document_id:
        document_id = generate_document_id()
    
    # Step 3: Create payload (without signature first)
    timestamp = datetime.now(timezone.utc).isoformat()
    payload = DocumentPayload(
        issuer=issuer,
        document_id=document_id,
        timestamp=timestamp,
        content=canonical,
    )
    
    # Step 4: Sign the canonical content using the private key
    signature = compute_signature(canonical, private_key)
    signed_payload = replace(payload, signature=signature, public_key=private_key)
    
    # Step 5: Serialize and compress
    payload_json = signed_payload.to_canonical_json()
    compressed = compress_payload(payload_json)
    
    # Step 6: Split into chunks
    data_chunks = split_into_chunks(compressed)
    
    # Step 7: Create QRed chunks
    qred_chunks = []
    for i, chunk_data in enumerate(data_chunks):
        chunk = QRedChunk(
            document_id=document_id,
            chunk_number=i,
            total_chunks=len(data_chunks),
            data=chunk_data,
        )
        qred_chunks.append(chunk)
    
    # Step 8: Create result
    result = SealGenerationResult(
        document_id=document_id,
        bootstrap_url=bootstrap_url,
        chunks=qred_chunks,
        payload_json=payload_json,
        total_chunks=len(data_chunks),
    )
    
    return result
