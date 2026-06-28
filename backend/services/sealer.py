"""QRed Sealer — canonicalize, sign, compress, chunk, and encode documents into QR seals."""

import base64
import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from backend.models import QRedChunk, SealGenerationResult
from backend.crypto import sign
from backend.services.text_recipes import validate_simple_english


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


def _fragment_data(payload: dict, chunk_text: str, chunk_number: int, total_chunks: int, recipe_id: str = "plaintext") -> str:
    """Build readable QRed fragment data with plaintext or recipe-encoded text."""
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
    if recipe_id and recipe_id != "plaintext":
        params["rc"] = recipe_id
    elif payload.get("recipe") and payload["recipe"] != "plaintext":
        params["rc"] = payload["recipe"]
    if chunk_number == 0:
        params["sig"] = payload["signature"]
    return "QRED1?" + urlencode(params)


def _fragment_url(bootstrap_url: str, fragment_data: str) -> str:
    return f"{_fragment_base(bootstrap_url)}#{fragment_data}"


def split_text_into_qr_urls(text: str, payload: dict, bootstrap_url: str, recipe_id: str = "plaintext") -> list[str]:
    """Split text into as many fragment URLs as needed to stay under QR limits."""
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
                    url = _fragment_url(bootstrap_url, _fragment_data(payload, candidate, len(text_chunks), total_chunks, recipe_id))
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
        _fragment_url(bootstrap_url, _fragment_data(payload, chunk, index, len(text_chunks), recipe_id))
        for index, chunk in enumerate(text_chunks)
    ]


def compute_key_id(public_key_b64: str) -> str:
    """Compute a stable key_id from a base64 Ed25519 public key.

    The key_id is the first 16 hex chars of SHA-256 of the raw public key bytes.
    """
    raw = base64.urlsafe_b64decode(public_key_b64)
    return hashlib.sha256(raw).hexdigest()[:16]


def _build_payload(
    base_fields: dict,
    content: str,
    recipe: str = "plaintext",
) -> dict:
    payload = {**base_fields, "content": content, "recipe": recipe}
    return payload


def _candidate_report(
    encoding: str,
    qr_count: int,
    reversible: bool,
    diagnostics: list[dict],
    recipe_id: str = "",
) -> dict:
    return {
        "encoding": encoding,
        "qr_count": qr_count,
        "reversible": reversible,
        "diagnostics": diagnostics,
        "recipe_id": recipe_id,
    }


def _select_candidate(candidates: list[dict], preferred: str = "automatic") -> dict:
    selectable = [candidate for candidate in candidates if candidate["reversible"]]
    if not selectable:
        return candidates[0]

    by_encoding = {candidate["encoding"]: candidate for candidate in candidates}
    by_recipe = {candidate.get("recipe", ""): candidate for candidate in candidates if candidate.get("recipe")}

    if preferred == "plaintext":
        return by_encoding["plaintext"]
    preferred_candidate = by_recipe.get(preferred) or by_encoding.get(preferred)
    if preferred_candidate is not None:
        return preferred_candidate

    return sorted(
        selectable,
        key=lambda candidate: (
            candidate["qr_count"],
            0 if candidate["encoding"] == "plaintext" else 1,
            candidate.get("recipe", ""),
        ),
    )[0]


def create_seals(
    document_text: str,
    issuer: str,
    private_key: str,
    public_key: str,
    document_id: Optional[str] = None,
    bootstrap_url: str = DEFAULT_BOOTSTRAP_URL,
    encoding_strategy: str = "automatic",
) -> SealGenerationResult:
    """Create QRed seals for a document.

    The payload contains: issuer_id, key_id (NOT the public key itself),
    and the signature. Verification requires looking up the public key
    from the issuer registry using (issuer_id, key_id).
    """
    key_id = compute_key_id(public_key)
    canonical = canonicalize_text(document_text)

    if not document_id:
        document_id = generate_document_id()

    signature = sign(canonical, private_key)
    timestamp = datetime.now(timezone.utc).isoformat()

    base_fields = {
        "algorithm": "Ed25519",
        "issuer": issuer,
        "key_id": key_id,
        "document_id": document_id,
        "timestamp": timestamp,
        "signature": signature,
        "version": "1",
    }

    plaintext_payload = _build_payload(base_fields, canonical, "plaintext")
    plaintext_json = json.dumps(plaintext_payload, sort_keys=True, separators=(",", ":"))
    plaintext_urls = split_text_into_qr_urls(canonical, plaintext_payload, bootstrap_url, "plaintext")
    plaintext_report = _candidate_report(
        "plaintext",
        len(plaintext_urls),
        True,
        [],
    )

    recipe_result = validate_simple_english(canonical)
    recipe_report = _candidate_report(
        recipe_result.recipe_id,
        0,
        recipe_result.reversible,
        [diag.to_dict() for diag in recipe_result.diagnostics],
        recipe_result.recipe_id,
    )
    recipe_urls: list[str] = []
    recipe_payload = None
    if recipe_result.reversible:
        recipe_payload = _build_payload(base_fields, recipe_result.compact, recipe_result.recipe_id)
        recipe_payload["recipe"] = recipe_result.recipe_id
        recipe_json = json.dumps(recipe_payload, sort_keys=True, separators=(",", ":"))
        recipe_urls = split_text_into_qr_urls(recipe_result.compact, recipe_payload, bootstrap_url, recipe_result.recipe_id)
        recipe_report["qr_count"] = len(recipe_urls)
    else:
        recipe_json = ""

    candidates = [
        {"encoding": "plaintext", "strings": plaintext_urls, **plaintext_report, "payload_json": plaintext_json, "recipe": "plaintext"},
    ]
    if recipe_result.reversible and recipe_payload is not None:
        candidates.insert(1, {"encoding": recipe_result.recipe_id, "strings": recipe_urls, **recipe_report, "payload_json": recipe_json, "recipe": recipe_result.recipe_id})

    selected = _select_candidate(candidates, encoding_strategy)

    qred_chunks = []
    for i, chunk_data in enumerate(selected["strings"]):
        chunk = QRedChunk(
            document_id=document_id,
            chunk_number=i,
            total_chunks=len(selected["strings"]),
            data=chunk_data,
        )
        qred_chunks.append(chunk)

    plaintext_count = plaintext_report["qr_count"]
    selected_count = selected["qr_count"]
    savings_pct = 0
    if plaintext_count > 0 and selected_count < plaintext_count:
        savings_pct = round(((plaintext_count - selected_count) / plaintext_count) * 100)

    return SealGenerationResult(
        document_id=document_id,
        bootstrap_url=bootstrap_url,
        chunks=qred_chunks,
        payload_json=selected.get("payload_json", plaintext_json),
        total_chunks=len(selected["strings"]),
        issuer=issuer,
        key_id=key_id,
        encoding=selected["encoding"],
        encoding_strategy=encoding_strategy,
        selected_recipe=selected.get("recipe", "plaintext"),
        estimated_qr_count=selected_count,
        compression_savings_pct=savings_pct,
        candidate_reports=[plaintext_report] + ([recipe_report] if recipe_result.reversible else []),
    )
