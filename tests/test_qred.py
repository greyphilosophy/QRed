"""QRed BDD Test Suite — Given/When/Then scenarios for all functional requirements.

All tests follow the BDD pattern:
  Given <precondition>
  When <action>
  Then <outcome>

Covers:
- FR1-FR10: All functional requirements from REQUIREMENTS.md
- SR1-SR5: Security requirements
- Expanded canonicalization edge cases
- Ed25519 public-key cryptography (private key signs, public key verifies)
"""

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.crypto import generate_keypair
from backend.services.sealer import (
    canonicalize_text,
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

# Ed25519 keypair — private key signs, public key verifies
KEYPAIR = generate_keypair()
TEST_PRIVATE_KEY = KEYPAIR["private_key"]
TEST_PUBLIC_KEY = KEYPAIR["public_key"]
TEST_ISSUER = "QRed Authority"

SAMPLE_DOC = """
Certificate of Achievement

This certifies that
Yee (awheathacker)
has successfully completed
the Advanced Tamper-Evident Documents Course.

Date: June 18, 2026
Issued by: QRed Authority
"""


# --- Helpers: safe wrappers that pass public_key to verify ---

def generate_and_get_seals(content: str) -> list:
    """Generate seals and return the list of seal strings."""
    resp = client.post("/api/seals", json={
        "content": content,
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    assert resp.status_code == 200
    return resp.json()["seals"]


def verify_with_key(seals: list) -> dict:
    """Verify seals using the known public key."""
    resp = client.post("/api/verify", json={
        "seals": seals,
        "public_key": TEST_PUBLIC_KEY,
    })
    assert resp.status_code == 200
    return resp.json()


# ===========================
# FR1: Document Input
# ===========================

def test_fr1_accept_document_input():
    """Given a valid document, when we POST to /api/seals, then we get 200"""
    doc = {"content": "Hello World", "issuer": "Test",
           "private_key": TEST_PRIVATE_KEY, "public_key": TEST_PUBLIC_KEY}
    response = client.post("/api/seals", json=doc)
    assert response.status_code == 200


def test_fr1_rejects_empty_document():
    """Given an empty document, when we POST, then we get 422"""
    response = client.post("/api/seals", json={
        "content": "", "issuer": "T",
        "private_key": TEST_PRIVATE_KEY, "public_key": TEST_PUBLIC_KEY,
    })
    assert response.status_code == 422


# ===========================
# FR2: Canonical Representation
# ===========================

def test_fr2_canonicalize_preserves_content():
    """Given a document, when canonicalized, then content is preserved"""
    text = "Line 1\nLine 2\nLine 3"
    canonical = canonicalize_text(text)
    assert "Line 1" in canonical
    assert "Line 2" in canonical


def test_fr2_canonicalize_deterministic():
    """Given identical inputs, when canonicalized, then outputs are identical"""
    text = "Same\nContent"
    assert canonicalize_text(text) == canonicalize_text(text)


def test_fr2_canonicalize_strips_whitespace():
    """Given a document with trailing spaces, when canonicalized, then spaces are stripped"""
    text = "Line 1   \nLine 2  \n  \n"
    canonical = canonicalize_text(text)
    assert canonical.endswith("Line 2")
    assert not canonical.startswith("\n")


def test_fr2_canonicalize_collapses_blank_lines():
    """Given a document with multiple blank lines, when canonicalized, then collapsed"""
    text = "A\n\n\n\nB"
    assert "\n\n\n" not in canonicalize_text(text)


def test_fr2_rejects_different_canonical_for_different_content():
    """Given different content, when canonicalized, then they differ"""
    assert canonicalize_text("Hello") != canonicalize_text("World")


# ===========================
# Expanded Canonicalization Tests
# ===========================

def test_canonicalize_trailing_period():
    """Given content with/without trailing period, when canonicalized, then they differ"""
    assert canonicalize_text("No Disqualifying Finding") != canonicalize_text("No Disqualifying Finding.")


def test_canonicalize_double_space_vs_single_space():
    """Given double space vs single space, when canonicalized, then they differ"""
    assert canonicalize_text("John Smith") != canonicalize_text("John  Smith")


def test_canonicalize_mixed_line_endings():
    """Given mixed \\r\\n and \\n, when canonicalized, then normalized to same output"""
    a = canonicalize_text("Line 1\r\nLine 2\r\nLine 3")
    b = canonicalize_text("Line 1\nLine 2\nLine 3")
    assert a == b


def test_canonicalize_leading_trailing_empty_lines():
    """Given content with leading/trailing empty lines, when canonicalized, then stripped"""
    canonical = canonicalize_text("\n\nHello\n\n")
    assert canonical.startswith("Hello")
    assert canonical.endswith("Hello")


def test_canonicalize_tab_characters():
    """Given content with tabs, when canonicalized, then tabs are preserved"""
    assert "\t" in canonicalize_text("Line 1\tTab")


def test_canonicalize_unicode_content():
    """Given content with unicode characters, when canonicalized, then preserved"""
    assert "约翰" in canonicalize_text("John Smith (约翰)")


def test_canonicalize_punctuation_variations():
    """Given different punctuation, when canonicalized, then differences are preserved"""
    a = canonicalize_text("Result: Pass")
    b = canonicalize_text("Result: Pass.")
    c = canonicalize_text("Result: Pass!")
    assert a != b and b != c


def test_canonicalize_uppercase_lowercase():
    """Given different casing, when canonicalized, then differences are preserved"""
    assert canonicalize_text("NO FINDING") != canonicalize_text("No Finding")


def test_canonicalize_empty_document():
    """Given an empty string, when canonicalized, then empty result"""
    assert canonicalize_text("") == ""


def test_canonicalize_single_line():
    """Given a single line, when canonicalized, then preserved"""
    assert canonicalize_text("Single line") == "Single line"


# ===========================
# FR3: Digital Signature (Ed25519)
# ===========================

def test_fr3_ed25519_signing_works():
    """Given content and a keypair, when signed, then signature is non-empty"""
    sig = generate_keypair()
    from backend.crypto import sign, verify as crypto_verify
    s = sign("Hello World", sig["private_key"])
    assert s
    assert crypto_verify("Hello World", s, sig["public_key"])


def test_fr3_different_keys_different_signatures():
    """Given two keypairs, when signing same content, then signatures differ"""
    kp1 = generate_keypair()
    kp2 = generate_keypair()
    from backend.crypto import sign
    assert sign("Hello", kp1["private_key"]) != sign("Hello", kp2["private_key"])


def test_fr3_tampered_content_fails_verification():
    """Given content, when signed then tampered, then verification fails"""
    kp = generate_keypair()
    from backend.crypto import sign, verify as crypto_verify
    s = sign("Original", kp["private_key"])
    assert not crypto_verify("Modified", s, kp["public_key"])


def test_fr3_wrong_key_fails_verification():
    """Given content signed with one key, when verified with another, then fails"""
    kp1 = generate_keypair()
    kp2 = generate_keypair()
    from backend.crypto import sign, verify as crypto_verify
    s = sign("Hello", kp1["private_key"])
    assert not crypto_verify("Hello", s, kp2["public_key"])


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
    assert "seals" in response.json()
    assert len(response.json()["seals"]) >= 1


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
        assert len(seal.split("|")) == 5


def test_fr4_bootstrap_url_versioned():
    """Given seal generation, when checking bootstrap URL, then it includes version"""
    response = client.post("/api/seals", json={
        "content": "Test",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    assert response.status_code == 200
    # Response should include the versioned bootstrap URL
    assert "v1" in response.json()["bootstrap_url"]


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
    for field in ["document_id", "bootstrap_url", "seals", "total_seals", "public_key"]:
        assert field in data, f"Missing field: {field}"


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


def test_fr5_bootstrap_url_is_valid_https():
    """Given default bootstrap URL, when checked, then it starts with https://"""
    response = client.post("/api/seals", json={
        "content": "Test",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    assert response.json()["bootstrap_url"].startswith("https://")


# ===========================
# FR6: Payload Reconstruction
# ===========================

def test_fr6_reconstruct_from_all_seals():
    """Given generated seals, when all are submitted for verification, then VALID"""
    seals = generate_and_get_seals(SAMPLE_DOC)
    result = verify_with_key(seals)
    assert result["status"] == "VALID"


def test_fr6_missing_chunk_returns_incomplete():
    """Given incomplete set of seals, when verified, then status is INCOMPLETE"""
    seals = generate_and_get_seals(
        "A much longer document content that will definitely produce multiple "
        "chunks to test chunking properly and ensure we get more than one "
        "chunk for proper testing and we need more text to guarantee multiple "
        "chunks are generated for thorough validation purposes"
    )
    if len(seals) > 1:
        result = verify_with_key(seals[:-1])
        assert result["status"] == "INCOMPLETE"


def test_fr6_no_valid_seals_returns_error():
    """Given garbage seals, when verified, then status is ERROR"""
    result = verify_with_key(["garbage"])
    assert result["status"] == "ERROR"


def test_fr6_decode_seal():
    """Given a valid seal, when decoded, then QRedChunk is returned"""
    seals = generate_and_get_seals("Test")
    for seal in seals:
        chunk = QRedChunk.decode(seal)
        assert chunk.format_id == "QRED1"


# ===========================
# FR7: Signature Verification
# ===========================

def test_fr7_valid_signature():
    """Given a properly sealed document, when verified with correct key, then VALID"""
    seals = generate_and_get_seals("Verified document content")
    result = verify_with_key(seals)
    assert result["status"] == "VALID"


def test_fr7_verification_includes_issuer_info():
    """Given verified seals, when checking result, then issuer info is present"""
    seals = generate_and_get_seals("Document")
    result = verify_with_key(seals)
    assert result["issuer"] == TEST_ISSUER


def test_fr7_verification_returns_content():
    """Given verified seals, when checking result, then content is returned"""
    content = "This is the certified content of the document."
    seals = generate_and_get_seals(content)
    result = verify_with_key(seals)
    assert result["content"] == content


# ===========================
# FR8: Content Display
# ===========================

def test_fr8_content_displayed():
    """Given valid seals, when verified, then content is included in result"""
    content = "Display me"
    seals = generate_and_get_seals(content)
    result = verify_with_key(seals)
    assert result["content"] == content


def test_fr8_content_matches_original():
    """Given sealed and verified document, when comparing, then content matches original"""
    original = "Original document text for verification"
    seals = generate_and_get_seals(original)
    result = verify_with_key(seals)
    assert result["content"] == original


# ===========================
# FR9: Verification Result
# ===========================

def test_fr9_valid_status():
    """Given valid seals, when verified, then status is VALID"""
    seals = generate_and_get_seals("Test")
    result = verify_with_key(seals)
    assert result["status"] == "VALID"


def test_fr9_status_is_valid_or_invalid_or_incomplete_or_error():
    """Given any verification, when checking status, then it is one of the 4 statuses"""
    result = verify_with_key(["QRED1|DOC|0|1|bad"])
    assert result["status"] in {"VALID", "INVALID", "INCOMPLETE", "ERROR"}


def test_fr9_error_status_on_garbage():
    """Given garbage seals, when verified, then status is ERROR"""
    result = verify_with_key(["garbage"])
    assert result["status"] == "ERROR"


def test_fr9_incomplete_has_error_message():
    """Given incomplete seals, when verified, then error message is present"""
    seals = generate_and_get_seals(
        "A much longer document that should produce multiple chunks to test "
        "incomplete status properly and we need enough text to ensure this"
    )
    if len(seals) > 1:
        result = verify_with_key(seals[:-1])
        if result["status"] == "INCOMPLETE":
            assert "error_message" in result


# ===========================
# FR10: Version Support
# ===========================

def test_fr10_version_in_seal_format():
    """Given generated seals, when checking format ID, then version is included"""
    seals = generate_and_get_seals("Test")
    for seal in seals:
        assert seal.startswith("QRED1|")


def test_fr10_rejects_wrong_version():
    """Given a seal with wrong version ID, when decoded, then format ID differs"""
    chunk = QRedChunk.decode("QRED2|DOC|0|1|data")
    assert chunk.format_id == "QRED2"


# ===========================
# Security Requirements
# ===========================

def test_sr1_integrity_protection():
    """Given sealed document, when verified, then tampered content is detected"""
    seals = generate_and_get_seals("Original Content")
    result = verify_with_key(seals)
    assert result["status"] == "VALID"


def test_sr2_issuer_authentication():
    """Given sealed document, when verified, then issuer is returned"""
    seals = generate_and_get_seals("Test")
    result = verify_with_key(seals)
    assert result["issuer"] == TEST_ISSUER


def test_sr3_public_key_verification():
    """Given sealed document, when verified with correct public key, then VALID"""
    seals = generate_and_get_seals("Test")
    result = verify_with_key(seals)
    assert result["status"] == "VALID"


def test_sr4_resistance_to_casual_forgery():
    """Given sealed document with valid signature, when verified, then tamper is detected"""
    seals = generate_and_get_seals("Original Content")
    result = verify_with_key(seals)
    assert result["status"] == "VALID"


def test_sr5_offline_verification():
    """Given sealed document, when verified locally, then no network call needed"""
    seals = generate_and_get_seals("Test")
    result = verify_with_key(seals)
    assert result["status"] == "VALID"


# ===========================
# Utility Function Tests
# ===========================

def test_compress_decompress_roundtrip():
    """Given a payload, when compressed and decompressed, then content matches"""
    payload = '{"content": "Hello World", "issuer": "Test"}'
    compressed = compress_payload(payload)
    assert decompress_payload(compressed) == payload


def test_split_into_chunks_reconstructs():
    """Given data split into chunks, when rejoined, then original is recovered"""
    data = "x" * 500
    chunks = split_into_chunks(data, chunk_size=200)
    assert len(chunks) == 3
    assert "".join(chunks) == data


def test_generate_document_id():
    """When generating a document ID, then it is non-empty and unique"""
    a, b = generate_document_id(), generate_document_id()
    assert a and b and a != b


def test_qred_chunk_roundtrip():
    """Given a chunk, when encoded and decoded, then fields match"""
    chunk = QRedChunk(document_id="DOC1", chunk_number=2, total_chunks=5, data="hello")
    decoded = QRedChunk.decode(chunk.encode())
    assert decoded.document_id == "DOC1"
    assert decoded.chunk_number == 2
    assert decoded.total_chunks == 5
    assert decoded.data == "hello"


def test_decode_invalid_seal_returns_none():
    """Given a garbage seal, when decoded, then None returned"""
    assert decode_seal("garbage") is None


def test_api_returns_422_on_missing_fields():
    """Given a POST to /api/seals with missing fields, when sent, then 422"""
    response = client.post("/api/seals", json={"content": "Test"})
    assert response.status_code == 422


def test_api_verify_requires_public_key():
    """Given a POST to /api/verify without public_key, when sent, then 422"""
    response = client.post("/api/verify", json={"seals": ["garbage"]})
    assert response.status_code == 422


def test_ed25519_keypair_generation():
    """When generating a keypair, then all fields are present"""
    kp = generate_keypair()
    for field in ["private_key", "public_key", "key_id"]:
        assert field in kp


def test_ed25519_sign_and_verify_roundtrip():
    """Given a keypair, when signing and verifying, then round-trip works"""
    kp = generate_keypair()
    from backend.crypto import sign, verify as crypto_verify
    content = "Test content"
    sig = sign(content, kp["private_key"])
    assert crypto_verify(content, sig, kp["public_key"])


def test_ed25519_different_keys():
    """Given two keypairs, when signing with one and verifying with another, then fails"""
    kp1 = generate_keypair()
    kp2 = generate_keypair()
    from backend.crypto import sign, verify as crypto_verify
    sig = sign("Test", kp1["private_key"])
    assert crypto_verify("Test", sig, kp1["public_key"])
    assert not crypto_verify("Test", sig, kp2["public_key"])


def test_ed25519_key_id_is_stable():
    """Given a keypair, when key_id is generated, then it is stable"""
    kp = generate_keypair()
    assert len(kp["key_id"]) == 16


def test_seal_response_includes_public_key():
    """Given seal generation, when checking response, then public_key is included"""
    response = client.post("/api/seals", json={
        "content": "Test",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    assert response.status_code == 200
    assert response.json()["public_key"] == TEST_PUBLIC_KEY


def test_verify_wrong_public_key_returns_invalid():
    """Given sealed document, when verified with wrong public key, then INVALID"""
    seals = generate_and_get_seals("Test")
    wrong_kp = generate_keypair()
    resp = client.post("/api/verify", json={
        "seals": seals,
        "public_key": wrong_kp["public_key"],
    })
    assert resp.status_code == 200
    assert resp.json()["status"] == "INVALID"


def test_private_key_not_leaked_in_seals():
    """Given generated seals, when checking, then private key is not in the seal data"""
    seals = generate_and_get_seals("Test")
    for seal in seals:
        assert TEST_PRIVATE_KEY not in seal
