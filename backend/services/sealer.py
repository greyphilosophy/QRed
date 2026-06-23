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


DEFAULT_BOOTSTRAP_URL = "https://qred.org/"
MAX_QR_PAYLOAD_LENGTH = 1200


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
    """Split payload data into fixed-size chunks."""
    chunks = []
    total_chunks = max(1, (len(data) + chunk_size - 1) // chunk_size)
    for i in range(total_chunks):
        start = i * chunk_size
        end = start + chunk_size
        chunks.append(data[start:end])
    return chunks


def _fragment_base(bootstrap_url: str) -> str:
    """Return the URL prefix used before the QRed fragment data."""
    return bootstrap_url.split("#", 1)[0] or DEFAULT_BOOTSTRAP_URL


def _fragment_data(payload: dict, chunk_text: str, chunk_number: int, total_chunks: int) -> str:
    """Build readable QRed fragment data with plaintext document text."""
    from urllib.parse import urlencode

    params = {
        "v": payload["version"],
        "alg": payload["algorithm"],
        "doc": payload["document_id"],
        "i": str(chunk_number),
        "n": str(total_chunks),
        "iss": payload["issuer"],
        "kid": payload["key_id"],
        "ts": payload["timestamp"],
        "txt": chunk_text,
    }
    if chunk_number == 0:
        params["sig"] = payload["signature"]
    return "QRED1?" + urlencode(params)


def _fragment_url(bootstrap_url: str, fragment_data: str) -> str:
    return f"{_fragment_base(bootstrap_url)}#{fragment_data}"


def split_text_into_qr_urls(text: str, payload: dict, bootstrap_url: str) -> list[str]:
    """Split plaintext into as many fragment URLs as needed to stay under QR limits."""
    if not text:
        text_chunks = [""]
    else:
        total_chunks = 1
        while True:
            text_chunks = []
            offset = 0
            while offset < len(text):
                low, high, best = 1, len(text) - offset, 0
                while low <= high:
                    mid = (low + high) // 2
                    candidate = text[offset:offset + mid]
                    url = _fragment_url(bootstrap_url, _fragment_data(payload, candidate, len(text_chunks), total_chunks))
                    if len(url) <= MAX_QR_PAYLOAD_LENGTH:
                        best = mid
                        low = mid + 1
                    else:
                        high = mid - 1
                if best == 0:
                    raise ValueError("QRed metadata and signature exceed the QR payload limit before adding document text")
                text_chunks.append(text[offset:offset + best])
                offset += best
            if len(text_chunks) == total_chunks:
                break
            total_chunks = len(text_chunks)

    return [
        _fragment_url(bootstrap_url, _fragment_data(payload, chunk, index, len(text_chunks)))
        for index, chunk in enumerate(text_chunks)
    ]


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
    bootstrap_url: str = DEFAULT_BOOTSTRAP_URL,
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

    # Split plaintext content into QRed fragment URLs.
    data_chunks = split_text_into_qr_urls(canonical, payload, bootstrap_url)

    # Create QRed chunks. For the new URL-fragment format, data already holds
    # the complete QR payload URL and encode() returns it unchanged.
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
