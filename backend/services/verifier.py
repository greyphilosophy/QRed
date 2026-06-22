"""QRed Verifier — reconstruct, decompress, verify, and display QRed payloads."""

import base64
import gzip
import json

from backend.crypto import verify as crypto_verify


def decode_seal(seal_string: str) -> dict | None:
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


def reconstruct_and_verify(
    seals: list[str],
    expected_public_key: str | None = None,
) -> dict:
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

        # Ensure all chunks belong to the same document. Mixing seals from
        # different documents must fail before reconstruction so chunk-number
        # collisions cannot silently produce a seemingly valid payload.
        if ctx["document_id"] and decoded["document_id"] != ctx["document_id"]:
            return {
                "status": "INVALID",
                "document_id": ctx["document_id"],
                "error_message": "Mixed document IDs",
            }

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
    issuer = payload.get("issuer", "")
    doc_id = payload.get("document_id", "")
    timestamp = payload.get("timestamp", "")

    # Verify signature using Ed25519
    if expected_public_key:
        is_valid = crypto_verify(content, signature, expected_public_key)
    elif payload.get("public_key"):
        is_valid = crypto_verify(content, signature, payload["public_key"])
    else:
        return {
            "status": "ERROR",
            "error_message": "No public key available for verification",
        }

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
