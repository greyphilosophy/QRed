"""QRed Sealer — canonicalize, sign, compress, chunk, and encode documents into QR seals."""

import base64
import gzip
import json
import uuid
from dataclasses import replace
from datetime import datetime, timezone
from typing import Optional

from backend.crypto import generate_keypair, sign
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


def create_seals(
    document_text: str,
    issuer: str,
    private_key: str,
    public_key: str,
    document_id: Optional[str] = None,
    bootstrap_url: str = "https://qred.org/verify/v1",
) -> SealGenerationResult:
    """Create QRed seals for a document.

    Workflow:
    1. Canonicalize document text
    2. Sign with Ed25519 private key
    3. Compress and chunk payload
    4. Encode as QRed chunk strings

    The payload contains: issuer_id, public_key_id (not the key itself),
    and the signature. Verification requires obtaining the public key
    from a trusted source matching the issuer_id.
    """
    # Step 1: Canonicalize
    canonical = canonicalize_text(document_text)
    
    # Step 2: Create document ID if not provided
    if not document_id:
        document_id = generate_document_id()
    
    # Step 3: Create payload metadata (uninitialized)
    timestamp = datetime.now(timezone.utc).isoformat()
    payload = DocumentPayload(
        issuer=issuer,
        document_id=document_id,
        timestamp=timestamp,
        content=canonical,
    )
    
    # Step 4: Sign the canonical content using Ed25519
    # In production, the payload stores issuer_id + key_id for public key lookup
    # The public key is NOT embedded in the payload itself
    signature = sign(canonical, private_key)
    signed_payload = replace(payload, signature=signature)
    
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
