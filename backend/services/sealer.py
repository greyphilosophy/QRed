"""QRed Sealer — canonicalize, sign, compress, chunk, and encode documents into QR seals."""

import base64
import gzip
import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from backend.models import QRedChunk, SealGenerationResult
from backend.crypto import sign


def generate_document_id() -> str:
    """Generate a unique document ID."""
    return f"DOC-{uuid.uuid4().hex[:12].upper()}"


def canonicalize_text(text: str) -> str:
    """Create a canonical text representation of document content."""
    lines = text.split("\n")
    lines = [line.rstrip() for line in lines]
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
    while collapsed and not collapsed[0]:
        collapsed.pop(0)
    while collapsed and not collapsed[-1]:
        collapsed.pop()
    return "\n".join(collapsed)


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
    """Split compressed payload data into fixed-size chunks."""
    chunks = []
    total_chunks = max(1, (len(data) + chunk_size - 1) // chunk_size)
    for i in range(total_chunks):
        start = i * chunk_size
        end = start + chunk_size
        chunks.append(data[start:end])
    return chunks


def compute_key_id(public_key_b64: str) -> str:
    """Compute a stable key_id from a base64 Ed25519 public key.

    The key_id is the first 16 hex chars of SHA-256 of the raw public key bytes.
    """
    raw = base64.urlsafe_b64decode(public_key_b64)
    return hashlib.sha256(raw).hexdigest()[:16]


def create_seals(
    document_text: str,
    issuer: str,
    private_key: str,
    public_key: str,
    document_id: Optional[str] = None,
    bootstrap_url: str = "https://qred.org/verify/v1",
) -> SealGenerationResult:
    """Create QRed seals for a document.

    The payload contains: issuer_id, key_id (NOT the public key itself),
    and the signature. Verification requires looking up the public key
    from the issuer registry using (issuer_id, key_id).
    """
    # Compute key_id from public key
    key_id = compute_key_id(public_key)

    # Canonicalize
    canonical = canonicalize_text(document_text)

    # Create document ID
    if not document_id:
        document_id = generate_document_id()

    # Sign with Ed25519
    signature = sign(canonical, private_key)

    # Build payload with key_id (not public_key)
    timestamp = datetime.now(timezone.utc).isoformat()
    payload = {
        "version": "1",
        "issuer": issuer,
        "key_id": key_id,
        "document_id": document_id,
        "timestamp": timestamp,
        "content": canonical,
        "signature": signature,
        "algorithm": "Ed25519",
    }
    payload_json = json.dumps(payload, sort_keys=True, separators=(",", ":"))

    # Compress
    compressed = compress_payload(payload_json)

    # Split into chunks
    data_chunks = split_into_chunks(compressed)

    # Create QRed chunks
    qred_chunks = []
    for i, chunk_data in enumerate(data_chunks):
        chunk = QRedChunk(
            document_id=document_id,
            chunk_number=i,
            total_chunks=len(data_chunks),
            data=chunk_data,
        )
        qred_chunks.append(chunk)

    return SealGenerationResult(
        document_id=document_id,
        bootstrap_url=bootstrap_url,
        chunks=qred_chunks,
        payload_json=payload_json,
        total_chunks=len(data_chunks),
        issuer=issuer,
        key_id=key_id,
    )
