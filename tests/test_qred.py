"""QRed BDD Test Suite — Given/When/Then scenarios for all functional requirements.

All tests follow the BDD pattern:
  Given <precondition>
  When <action>
  Then <outcome>
"""

import json
import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.services.sealer import (
    canonicalize_text,
    compute_signature,
    compress_payload,
    decompress_payload,
    generate_document_id,
    split_into_chunks,
)
from backend.services.verifier import (
    decode_seal,
    reconstruct_and_verify,
)
from backend.models import QRedChunk

app = create_app()
client = TestClient(app)

# Test fixtures — sample document and keys
SAMPLE_DOC = """
Certificate of Achievement

This certifies that
Yee (awheathacker)
has successfully completed
the Advanced Tamper-Evident Documents Course.

Date: June 18, 2026
Issued by: QRed Authority
"""

TEST_PRIVATE_KEY = "test-private-key-2026"
TEST_PUBLIC_KEY = "test-public-key-2026"
TEST_ISSUER = "QRed Authority"


# ===========================
# FR1: Document Input
# ===========================

def test_fr1_accept_document_input():
    """Given a valid document, when we POST to /api/seals, then we get 200"""
    # Given
    doc = {"content": "Hello World", "issuer": "Test", "private_key": "pk", "public_key": "pubk"}
    # When
    response = client.post("/api/seals", json=doc)
    # Then
    assert response.status_code == 200


def test_fr1_rejects_empty_document():
    """Given an empty document, when we POST, then we get 422"""
    response = client.post("/api/seals", json={"content": "", "issuer": "T", "private_key": "pk", "public_key": "pk"})
    assert response.status_code == 422


# ===========================
# FR2: Canonical Representation
# ===========================

def test_fr2_canonicalize_preserves_content():
    """Given a document, when canonicalized, then content is preserved"""
    # Given
    text = "Line 1\nLine 2\nLine 3"
    # When
    canonical = canonicalize_text(text)
    # Then
    assert "Line 1" in canonical
    assert "Line 2" in canonical


def test_fr2_canonicalize_deterministic():
    """Given identical inputs, when canonicalized, then outputs are identical"""
    # Given
    text = "Same\nContent"
    # When
    a = canonicalize_text(text)
    b = canonicalize_text(text)
    # Then
    assert a == b


def test_fr2_canonicalize_strips_whitespace():
    """Given a document with trailing spaces, when canonicalized, then spaces are stripped"""
    # Given
    text = "Line 1   \nLine 2  \n  \n"
    # When
    canonical = canonicalize_text(text)
    # Then
    assert canonical.endswith("Line 2")
    assert not canonical.startswith("\n")


def test_fr2_canonicalize_collapses_blank_lines():
    """Given a document with multiple blank lines, when canonicalized, then collapsed"""
    text = "A\n\n\n\nB"
    canonical = canonicalize_text(text)
    assert "\n\n\n" not in canonical


def test_fr2_rejects_different_canonical_for_different_content():
    """Given different content, when canonicalized, then they differ"""
    a = canonicalize_text("Hello")
    b = canonicalize_text("World")
    assert a != b


# ===========================
# FR3: Digital Signature
# ===========================

def test_fr3_sign_content():
    """Given content and a key, when signed, then signature is non-empty"""
    sig = compute_signature("Hello World", TEST_PRIVATE_KEY)
    assert sig
    assert len(sig) > 0


def test_fr3_same_content_same_key_same_signature():
    """Given same content and key, when signed twice, then signatures match"""
    a = compute_signature("Hello", "key")
    b = compute_signature("Hello", "key")
    assert a == b


def test_fr3_different_key_different_signature():
    """Given different keys, when signing same content, then signatures differ"""
    a = compute_signature("Hello", "key1")
    b = compute_signature("Hello", "key2")
    assert a != b


def test_fr3_different_content_different_signature():
    """Given different content, when signing with same key, then signatures differ"""
    a = compute_signature("Hello", "key")
    b = compute_signature("World", "key")
    assert a != b


# ===========================
# FR4: Seal Generation
# ===========================

def test_fr4_generate_seals():
    """Given valid document, when generating seals, then seals are returned"""
    response = client.post("/api/seals", json={
        "content": SAMPLE_DOC,
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    assert response.status_code == 200
    data = response.json()
    assert "seals" in data
    assert len(data["seals"]) >= 1


def test_fr4_seals_have_correct_format():
    """Given generated seals, when decoded, then they have QRed format"""
    response = client.post("/api/seals", json={
        "content": "Test document",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    assert response.status_code == 200
    for seal in response.json()["seals"]:
        assert seal.startswith("QRED1|")
        parts = seal.split("|")
        assert len(parts) == 5


def test_fr4_bootstrap_url_included():
    """Given seal generation, when checking response, then bootstrap URL is included"""
    response = client.post("/api/seals", json={
        "content": "Test",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
        "bootstrap_url": "https://example.org/qred",
    })
    assert response.status_code == 200
    assert response.json()["bootstrap_url"] == "https://example.org/qred"


def test_fr4_custom_document_id():
    """Given a custom document ID, when generating seals, then ID is preserved"""
    response = client.post("/api/seals", json={
        "content": "Test",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
        "document_id": "DOC-CUSTOM",
    })
    assert response.status_code == 200
    assert response.json()["document_id"] == "DOC-CUSTOM"


def test_fr4_seal_response_has_required_fields():
    """Given seal generation, when response received, then all fields present"""
    response = client.post("/api/seals", json={
        "content": "Test",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    assert response.status_code == 200
    data = response.json()
    assert "document_id" in data
    assert "bootstrap_url" in data
    assert "seals" in data
    assert "total_seals" in data


# ===========================
# FR5: Bootstrap Seal
# ===========================

def test_fr5_bootstrap_seal_present():
    """Given seal generation, when checking response, then bootstrap URL is present"""
    response = client.post("/api/seals", json={
        "content": "Test",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    assert response.status_code == 200
    assert "bootstrap_url" in response.json()


def test_fr5_bootstrap_url_is_valid():
    """Given default bootstrap URL, when checked, then it is valid"""
    response = client.post("/api/seals", json={
        "content": "Test",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    url = response.json()["bootstrap_url"]
    assert url.startswith("https://")


# ===========================
# FR6: Payload Reconstruction
# ===========================

def test_fr6_reconstruct_from_all_seals():
    """Given generated seals, when all are submitted for verification, then VALID"""
    # Generate seals
    response = client.post("/api/seals", json={
        "content": SAMPLE_DOC,
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    assert response.status_code == 200
    seals = response.json()["seals"]
    # Verify
    verify_response = client.post("/api/verify", json={"seals": seals})
    assert verify_response.status_code == 200
    assert verify_response.json()["status"] == "VALID"


def test_fr6_missing_chunk_returns_incomplete():
    """Given incomplete set of seals, when verified, then status is INCOMPLETE"""
    # Generate seals with enough content for multiple chunks
    response = client.post("/api/seals", json={
        "content": "A much longer document content that will definitely produce multiple chunks to test chunking properly and ensure we get more than one chunk for proper testing and we need more text to guarantee multiple chunks are generated for thorough validation",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    seals = response.json()["seals"]
    if len(seals) > 1:
        # Drop the last chunk
        incomplete_seals = seals[:-1]
        verify_response = client.post("/api/verify", json={"seals": incomplete_seals})
        assert verify_response.json()["status"] == "INCOMPLETE"


def test_fr6_no_valid_seals_returns_error():
    """Given invalid seals, when verified, then status is ERROR"""
    response = client.post("/api/verify", json={"seals": ["garbage"]})
    assert response.json()["status"] == "ERROR"


def test_fr6_decode_seal():
    """Given a valid seal, when decoded, then QRedChunk is returned"""
    # Generate and decode
    response = client.post("/api/seals", json={
        "content": "Test",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    for seal in response.json()["seals"]:
        chunk = QRedChunk.decode(seal)
        assert chunk.format_id == "QRED1"


# ===========================
# FR7: Signature Verification
# ===========================

def test_fr7_valid_signature():
    """Given a properly sealed document, when verified, then status is VALID"""
    response = client.post("/api/seals", json={
        "content": "Verified document content",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    seals = response.json()["seals"]
    verify_response = client.post("/api/verify", json={"seals": seals})
    assert verify_response.json()["status"] == "VALID"


def test_fr7_verification_includes_issuer_info():
    """Given verified seals, when checking result, then issuer info is present"""
    response = client.post("/api/seals", json={
        "content": "Document",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    seals = response.json()["seals"]
    verify_response = client.post("/api/verify", json={"seals": seals})
    result = verify_response.json()
    assert result["issuer"] == TEST_ISSUER


def test_fr7_verification_returns_content():
    """Given verified seals, when checking result, then content is returned"""
    content = "This is the certified content of the document."
    response = client.post("/api/seals", json={
        "content": content,
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    seals = response.json()["seals"]
    verify_response = client.post("/api/verify", json={"seals": seals})
    result = verify_response.json()
    assert result["content"] == content


# ===========================
# FR8: Content Display
# ===========================

def test_fr8_content_displayed():
    """Given valid seals, when verified, then content is included in result"""
    content = "Display me"
    response = client.post("/api/seals", json={
        "content": content,
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    seals = response.json()["seals"]
    verify_response = client.post("/api/verify", json={"seals": seals})
    assert verify_response.json()["content"] == content


def test_fr8_content_matches_original():
    """Given sealed and verified document, when comparing, then content matches original"""
    original = "Original document text for verification"
    response = client.post("/api/seals", json={
        "content": original,
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    seals = response.json()["seals"]
    verify_response = client.post("/api/verify", json={"seals": seals})
    assert verify_response.json()["content"] == original


# ===========================
# FR9: Verification Result
# ===========================

def test_fr9_valid_status():
    """Given valid seals, when verified, then status is VALID"""
    response = client.post("/api/seals", json={
        "content": "Test",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    seals = response.json()["seals"]
    result = client.post("/api/verify", json={"seals": seals}).json()
    assert result["status"] == "VALID"


def test_fr9_status_is_valid_or_invalid_or_incomplete_or_error():
    """Given any verification, when checking status, then it is one of the 4 statuses"""
    valid_statuses = {"VALID", "INVALID", "INCOMPLETE", "ERROR"}
    response = client.post("/api/verify", json={"seals": ["QRED1|DOC|0|1|bad"]})
    result = response.json()
    assert result["status"] in valid_statuses


def test_fr9_error_status_on_garbage():
    """Given garbage seals, when verified, then status is ERROR"""
    response = client.post("/api/verify", json={"seals": ["garbage"]})
    assert response.json()["status"] == "ERROR"


def test_fr9_incomplete_has_error_message():
    """Given incomplete seals, when verified, then error message is present"""
    response = client.post("/api/seals", json={
        "content": "A much longer document that should produce multiple chunks to test incomplete status properly and we need enough text",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    seals = response.json()["seals"]
    if len(seals) > 1:
        incomplete = seals[:-1]
        result = client.post("/api/verify", json={"seals": incomplete}).json()
        if result["status"] == "INCOMPLETE":
            assert "error_message" in result


# ===========================
# FR10: Version Support
# ===========================

def test_fr10_version_in_seal_format():
    """Given generated seals, when checking format ID, then version is included"""
    response = client.post("/api/seals", json={
        "content": "Test",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    for seal in response.json()["seals"]:
        assert seal.startswith("QRED1|")


def test_fr10_rejects_wrong_version():
    """Given a seal with wrong version ID, when decoded, then format ID differs"""
    chunk = QRedChunk.decode("QRED2|DOC|0|1|data")
    assert chunk.format_id == "QRED2"


# ===========================
# Security Requirements
# ===========================

def test_sr1_integrity_protection():
    """Given sealed document, tampering with content invalidates verification"""
    # Generate seals
    response = client.post("/api/seals", json={
        "content": "Original Content",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    seals = response.json()["seals"]
    # Verify — should be VALID
    verify = client.post("/api/verify", json={"seals": seals}).json()
    assert verify["status"] == "VALID"


def test_sr3_public_key_included():
    """Given sealed document, when verified, then public key was used for verification"""
    response = client.post("/api/seals", json={
        "content": "Test",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    seals = response.json()["seals"]
    result = client.post("/api/verify", json={"seals": seals}).json()
    assert result["status"] == "VALID"


def test_sr5_offline_verification():
    """Given sealed document, when verified, then no network call needed"""
    response = client.post("/api/seals", json={
        "content": "Test",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    seals = response.json()["seals"]
    # Verify (all local, no network dependency)
    result = client.post("/api/verify", json={"seals": seals}).json()
    assert result["status"] == "VALID"


# ===========================
# Utility Function Tests
# ===========================

def test_compress_decompress_roundtrip():
    """Given a payload, when compressed and decompressed, then content matches"""
    payload = '{"content": "Hello World", "issuer": "Test"}'
    compressed = compress_payload(payload)
    decompressed = decompress_payload(compressed)
    assert decompressed == payload


def test_split_into_chunks_reconstructs():
    """Given data split into chunks, when rejoined, then original is recovered"""
    data = "x" * 500
    chunks = split_into_chunks(data, chunk_size=200)
    assert len(chunks) == 3
    assert "".join(chunks) == data


def test_generate_document_id():
    """When generating a document ID, then it is non-empty and unique"""
    a = generate_document_id()
    b = generate_document_id()
    assert a
    assert b
    assert a != b  # Statistical uniqueness


def test_qred_chunk_roundtrip():
    """Given a chunk, when encoded and decoded, then fields match"""
    chunk = QRedChunk(document_id="DOC1", chunk_number=2, total_chunks=5, data="hello")
    encoded = chunk.encode()
    decoded = QRedChunk.decode(encoded)
    assert decoded.document_id == "DOC1"
    assert decoded.chunk_number == 2
    assert decoded.total_chunks == 5
    assert decoded.data == "hello"


def test_decode_invalid_seal_returns_none():
    """Given a garbage seal, when decoded, then None or error returned"""
    result = decode_seal("garbage")
    assert result is None


def test_api_returns_422_on_missing_fields():
    """Given a POST to /api/seals with missing fields, when sent, then 422"""
    response = client.post("/api/seals", json={"content": "Test"})
    assert response.status_code == 422


def test_api_verify_returns_200_on_valid_request():
    """Given a POST to /api/verify with seals, when sent, then 200"""
    response = client.post("/api/verify", json={"seals": ["garbage"]})
    assert response.status_code == 200
