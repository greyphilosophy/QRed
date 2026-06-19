"""QRed Verifier — reconstruct, decompress, verify, and display QRed payloads."""

import base64
import gzip
import json
from dataclasses import dataclass
from typing import Optional


@dataclass
class VerificationContext:
    """Mutable state for a verification operation."""
    chunks: Optional[dict] = None
    total_chunks: int = 0
    document_id: str = ""
    status: str = "ERROR"

    def __post_init__(self):
        if self.chunks is None:
            self.chunks = {}


def decode_seal(seal_string: str) -> Optional[dict]:
    """Decode a QRed seal string into a chunk dict."""
    parts = seal_string.split("|", 4)
    if len(parts) < 5:
        return None
    fmt_id, doc_id, chunk_num, total, data = parts
    if not fmt_id.startswith("QRED"):
        return None
    return {
        "format_id": fmt_id,
        "document_id": doc_id,
        "chunk_number": int(chunk_num),
        "total_chunks": int(total),
        "data": data,
    }


def reconstruct_and_verify(seals: list[str], expected_public_key: Optional[str] = None) -> dict:
    """Reconstruct payload from seal strings and verify the signature.

    Returns a verification result dict with:
    - status: "VALID", "INVALID", "INCOMPLETE", or "ERROR"
    - content: the verified document content (if VALID)
    - issuer: the issuing authority name
    - document_id: the document identifier
    - timestamp: the creation timestamp
    - error_message: human-readable error (if any)
    """
    ctx: dict = {"chunks": {}, "document_id": "", "total_chunks": 0, "errors": []}

    for seal in seals:
        decoded = decode_seal(seal)
        if decoded is None:
            ctx["errors"].append(f"Malformed seal: {seal[:50]}")
            continue

        # Ensure all chunks belong to the same document
        if ctx["document_id"] and decoded["document_id"] != ctx["document_id"]:
            ctx["document_id"] = ""  # Mixed documents
            continue

        if not ctx["document_id"]:
            ctx["document_id"] = decoded["document_id"]
        ctx["total_chunks"] = decoded["total_chunks"]
        ctx["chunks"][decoded["chunk_number"]] = decoded["data"]

    # Check completeness
    if ctx["chunks"]:
        expected = set(range(ctx["total_chunks"]))
        received = set(ctx["chunks"].keys())
        if not expected.issubset(received):
            missing = expected - received
            return {
                "status": "INCOMPLETE",
                "document_id": ctx["document_id"],
                "error_message": f"Missing chunks: {sorted(missing)}",
            }

    # Reconstruct data in order
    if not ctx["chunks"]:
        return {
            "status": "ERROR",
            "error_message": "No valid chunks found",
        }

    ordered_data = []
    for i in range(ctx["total_chunks"]):
        ordered_data.append(ctx["chunks"][i])

    raw_data = "".join(ordered_data)

    # Decompress
    try:
        compressed = base64.urlsafe_b64decode(raw_data)
        payload_json = gzip.decompress(compressed).decode("utf-8")
        payload = json.loads(payload_json)
    except Exception as e:
        return {
            "status": "ERROR",
            "error_message": f"Decompression failed: {e}",
        }

    # Extract fields
    content = payload.get("content", "")
    signature = payload.get("signature", "")
    public_key = payload.get("public_key", "")
    issuer = payload.get("issuer", "")
    doc_id = payload.get("document_id", "")
    timestamp = payload.get("timestamp", "")

    # Verify signature — use the embedded public key
    verify_key = expected_public_key or public_key
    from backend.services.sealer import verify_signature
    is_valid = verify_signature(content, signature, verify_key)

    if is_valid:
        return {
            "status": "VALID",
            "issuer": issuer,
            "document_id": doc_id,
            "timestamp": timestamp,
            "content": content,
        }
    else:
        return {
            "status": "INVALID",
            "issuer": issuer,
            "document_id": doc_id,
            "error_message": "Digital signature verification failed",
            "content": content,
        }
