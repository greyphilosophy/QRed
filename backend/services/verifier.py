"""QRed Verifier — reconstruct, decompress, verify, and display QRed payloads."""

import base64
import gzip
import json
from collections.abc import Callable

from backend.crypto import verify as crypto_verify


def _seal_fragment(seal_string: str) -> str:
    return seal_string.split("#", 1)[1] if "#" in seal_string else seal_string


def _decode_plaintext_fragment(fragment: str) -> dict | None:
    from urllib.parse import parse_qs

    if not fragment.startswith("QRED1?"):
        return None
    params = {key: values[0] for key, values in parse_qs(fragment[len("QRED1?"):], keep_blank_values=True).items()}
    try:
        chunk_number = int(params.get("i", ""))
        total_chunks = int(params.get("n", ""))
    except ValueError:
        return None
    document_id = params.get("doc", "")
    if not document_id:
        return None
    return {
        "format_id": "QRED1",
        "document_id": document_id,
        "chunk_number": chunk_number,
        "total_chunks": total_chunks,
        "data": params.get("txt", ""),
        "plaintext": True,
        "algorithm": params.get("alg", "Ed25519"),
        "issuer": params.get("iss", ""),
        "key_id": params.get("kid", ""),
        "signature": params.get("sig", ""),
        "timestamp": params.get("ts", ""),
        "version": params.get("v", "1"),
    }


def decode_seal(seal_string: str) -> dict | None:
    """Decode a QRed seal string into a chunk dict."""
    fragment = _seal_fragment(seal_string)
    plaintext = _decode_plaintext_fragment(fragment)
    if plaintext:
        return plaintext
    parts = fragment.split("|", 4)
    if len(parts) < 5:
        return None
    fmt_id, doc_id, chunk_num, total, data = parts
    if not fmt_id.startswith("QRED"):
        return None
    try:
        chunk_number = int(chunk_num)
        total_chunks = int(total)
    except ValueError:
        return None

    return {
        "format_id": fmt_id,
        "document_id": doc_id,
        "chunk_number": chunk_number,
        "total_chunks": total_chunks,
        "data": data,
    }


def reconstruct_and_verify(
    seals: list[str],
    expected_public_key: str | None = None,
    registry_lookup: Callable[[str, str], str | None] | None = None,
) -> dict:
    """Reconstruct payload from seal strings and verify the signature.

    Returns a verification result dict with:
    - status: "VALID", "INVALID", "INCOMPLETE", or "ERROR"
    - content: the verified document content (if VALID)
    - issuer: the issuing authority name
    - document_id: the document identifier
    - timestamp: the creation timestamp
    - error_message: human-readable error (if any)

    Verification requires a trusted key source. Callers must either provide
    expected_public_key explicitly or provide registry_lookup, which resolves
    the payload's (issuer, key_id) to a trusted public key. Public keys
    embedded in the payload are intentionally ignored because the payload is
    untrusted until its signature is verified.
    """
    ctx: dict = {"chunks": {}, "document_id": "", "total_chunks": 0, "errors": [], "plaintext": False, "metadata": {}}

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
        if decoded.get("plaintext"):
            ctx["plaintext"] = True
            for key in ("algorithm", "issuer", "key_id", "signature", "timestamp", "version"):
                if decoded.get(key):
                    ctx["metadata"][key] = decoded[key]

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

    # Decode payload
    try:
        if ctx["plaintext"]:
            payload = {
                "content": raw_data,
                "document_id": ctx["document_id"],
                "issuer": ctx["metadata"].get("issuer", ""),
                "key_id": ctx["metadata"].get("key_id", ""),
                "signature": ctx["metadata"].get("signature", ""),
                "timestamp": ctx["metadata"].get("timestamp", ""),
                "algorithm": ctx["metadata"].get("algorithm", "Ed25519"),
                "version": ctx["metadata"].get("version", "1"),
            }
        else:
            compressed = base64.urlsafe_b64decode(raw_data)
            payload_json = gzip.decompress(compressed).decode("utf-8")
            payload = json.loads(payload_json)
    except Exception as e:
        return {
            "status": "ERROR",
            "error_message": f"Payload decoding failed: {e}",
        }

    # Extract fields
    content = payload.get("content", "")
    signature = payload.get("signature", "")
    issuer = payload.get("issuer", "")
    doc_id = payload.get("document_id", "")
    timestamp = payload.get("timestamp", "")
    key_id = payload.get("key_id", "")

    # Verify signature using Ed25519 with a trusted key source.
    public_key = expected_public_key
    if not public_key and registry_lookup:
        if issuer and key_id:
            public_key = registry_lookup(issuer, key_id)
        if not public_key:
            return {
                "status": "ERROR",
                "document_id": doc_id,
                "issuer": issuer,
                "error_message": "No trusted public key found for issuer/key_id",
            }

    if not public_key:
        return {
            "status": "ERROR",
            "document_id": doc_id,
            "issuer": issuer,
            "error_message": "No trusted public key available for verification",
        }

    is_valid = crypto_verify(content, signature, public_key)

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
