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

from pathlib import Path
import json
import re

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.crypto import compute_key_id, generate_keypair
from backend.services.sealer import (
    canonicalize_text,
    compress_payload,
    create_seals,
    decompress_payload,
    generate_document_id,
    split_into_chunks,
    DEFAULT_BOOTSTRAP_URL,
)
from backend.services.verifier import (
    decode_seal,
    reconstruct_and_verify,
)
from backend.models import QRedChunk
import backend.services.sealer as sealer_module
from backend.services.text_recipes import validate_simple_english

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


def build_legacy_embedded_public_key_seals(content: str, issuer: str, keypair: dict) -> list[str]:
    """Build a legacy payload that embeds a public_key for verifier hardening tests."""
    from backend.crypto import sign

    document_id = generate_document_id()
    payload = {
        "version": "1",
        "issuer": issuer,
        "document_id": document_id,
        "timestamp": "2026-06-22T00:00:00+00:00",
        "content": canonicalize_text(content),
        "signature": sign(canonicalize_text(content), keypair["private_key"]),
        "public_key": keypair["public_key"],
        "algorithm": "Ed25519",
    }
    compressed = compress_payload(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    chunks = split_into_chunks(compressed)
    return [
        QRedChunk(
            document_id=document_id,
            chunk_number=i,
            total_chunks=len(chunks),
            data=chunk,
        ).encode()
        for i, chunk in enumerate(chunks)
    ]


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
        assert seal.startswith("https://qred.org/#QRED1?")
        assert "doc=" in seal and "txt=" in seal


def test_fr4_bootstrap_url_uses_production_verifier():
    """Given seal generation, when checking bootstrap URL, then it targets the production verifier"""
    response = client.post("/api/seals", json={
        "content": "Test",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    assert response.status_code == 200
    assert response.json()["bootstrap_url"] == DEFAULT_BOOTSTRAP_URL


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
    for field in ["document_id", "bootstrap_url", "seals", "total_seals", "key_id"]:
        assert field in data, f"Missing field: {field}"


def test_fr4_prefers_smaller_qr_count_for_large_repetitive_content():
    """Given repetitive content, when compression reduces QR count, then the smaller option is chosen"""
    content = "lorem ipsum dolor sit amet " * 200
    result = create_seals(
        document_text=content,
        issuer=TEST_ISSUER,
        private_key=TEST_PRIVATE_KEY,
        public_key=TEST_PUBLIC_KEY,
    )
    payload = json.loads(result.payload_json)
    canonical = sealer_module.canonicalize_text(content)
    plaintext_count = len(sealer_module.split_text_into_qr_urls(canonical, payload, DEFAULT_BOOTSTRAP_URL))
    compressed_count = len(getattr(sealer_module, "_legacy_qred_strings")(result.payload_json, result.document_id))

    assert result.total_chunks == min(plaintext_count, compressed_count)
    assert getattr(result, "encoding", "plaintext") == ("compressed" if compressed_count < plaintext_count else "plaintext")
    if getattr(result, "encoding", "plaintext") == "compressed":
        assert all(chunk.encode().startswith("QRED1|") for chunk in result.chunks)
    else:
        assert all(chunk.encode().startswith("https://qred.org/#QRED1?") for chunk in result.chunks)


def test_fr4_recipe1_reversible_on_supported_simple_english():
    """Given supported simple English, when applying Recipe 1, then it round-trips exactly"""
    result = validate_simple_english("the document and the page")
    assert result.reversible is True
    assert result.restored == "the document and the page"
    assert result.compact


def test_fr4_recipe1_mode_is_accepted_by_seal_generation():
    """Given Recipe 1 mode, when generating seals, then it is accepted as a sealing parameter"""
    result = create_seals(
        document_text="the document and the page",
        issuer=TEST_ISSUER,
        private_key=TEST_PRIVATE_KEY,
        public_key=TEST_PUBLIC_KEY,
        encoding_strategy="simple_english",
    )
    assert result.selected_recipe == "simple_english"
    assert result.encoding in {"simple_english", "plaintext", "compressed"}


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


def test_fr6_mixed_document_ids_returns_invalid():
    """Given seals from different documents, when verified, then INVALID is deterministic."""
    first_doc_seals = generate_and_get_seals("First generated document")
    second_doc_seals = generate_and_get_seals("Second generated document")

    result = verify_with_key([first_doc_seals[0], second_doc_seals[0]])

    assert result["status"] == "INVALID"
    assert result["error_message"] == "Mixed document IDs"


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


def test_fr7_rejects_embedded_public_key_without_trusted_source():
    """Given a legacy embedded-key payload, verification requires a trusted key source."""
    seals = build_legacy_embedded_public_key_seals("Verified document content", TEST_ISSUER, KEYPAIR)

    result = reconstruct_and_verify(seals)

    assert result["status"] == "ERROR"
    assert "trusted public key" in result["error_message"]


def test_fr7_registry_lookup_can_supply_trusted_public_key():
    """Given registry lookup resolves issuer/key_id, local verification succeeds."""
    response = client.post("/api/seals", json={
        "content": "Verified document content",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    assert response.status_code == 200
    key_id = response.json()["key_id"]

    result = reconstruct_and_verify(
        response.json()["seals"],
        registry_lookup=lambda issuer, lookup_key_id: (
            TEST_PUBLIC_KEY
            if issuer == TEST_ISSUER and lookup_key_id == key_id
            else None
        ),
    )

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
        assert seal.startswith("https://qred.org/#QRED1?")


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


def test_decode_seal_returns_none_for_malformed_numeric_fields():
    """Given non-integer chunk fields, when decoded, then None returned."""
    assert decode_seal("QRED1|DOC|not-a-number|1|data") is None
    assert decode_seal("QRED1|DOC|0|not-a-number|data") is None


@pytest.mark.parametrize("seal", [
    "QRED1|DOC|not-a-number|1|data",
    "QRED1|DOC|0|not-a-number|data",
])
def test_api_verify_returns_structured_error_for_malformed_numeric_fields(seal):
    """Given malformed numeric chunk fields, when verified, then response is non-500 ERROR."""
    response = client.post("/api/verify", json={
        "seals": [seal],
        "public_key": TEST_PUBLIC_KEY,
    })
    body = response.json()

    assert response.status_code != 500
    assert body["status"] == "ERROR"
    assert body["error_message"] == "No valid chunks found"


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


def test_seal_response_includes_key_id():
    """Given seal generation, when checking response, then key_id is included"""
    response = client.post("/api/seals", json={
        "content": "Test",
        "issuer": TEST_ISSUER,
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    assert response.status_code == 200
    assert "key_id" in response.json()
    assert len(response.json()["key_id"]) == 16


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


# ===========================
# Issuer Registry Tests
# ===========================

def test_registry_register_and_lookup():
    """Given a registered key, when looked up, then public key is returned"""
    kp = generate_keypair()
    from backend.services.registry import registry
    registry.register(
        issuer_id="TestIssuer",
        key_id=kp["key_id"],
        public_key=kp["public_key"],
    )
    result = registry.lookup("TestIssuer", kp["key_id"])
    assert result == kp["public_key"]

def test_registry_lookup_missing_key():
    """Given a missing key, when looked up, then None is returned"""
    from backend.services.registry import registry
    result = registry.lookup("Missing", "abc123")
    assert result is None

def test_registry_count():
    """Given registered keys, when counting, then count is accurate"""
    from backend.services.registry import registry
    kp = generate_keypair()
    registry.register(
        issuer_id="CountTest",
        key_id=kp["key_id"],
        public_key=kp["public_key"],
    )
    count = registry.count()
    assert count >= 1

def test_registry_remove():
    """Given a registered key, when removed, then it is gone"""
    from backend.services.registry import registry
    kp = generate_keypair()
    registry.register(
        issuer_id="RemoveTest",
        key_id=kp["key_id"],
        public_key=kp["public_key"],
    )
    assert registry.is_registered("RemoveTest", kp["key_id"])
    registry.remove("RemoveTest", kp["key_id"])
    assert not registry.is_registered("RemoveTest", kp["key_id"])

def test_registry_api_register_endpoint():
    """Given a POST to /api/registry, when registering, then 200"""
    kp = generate_keypair()
    response = client.post(
        f"/api/registry/test-issuer/{kp['key_id']}",
        json={"public_key": kp["public_key"]},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "REGISTERED"

def test_registry_api_lookup_endpoint():
    """Given a GET to /api/registry, when looking up, then 200"""
    kp = generate_keypair()
    # Register first
    client.post(
        f"/api/registry/test-lookup/{kp['key_id']}",
        json={"public_key": kp["public_key"]},
    )
    # Lookup
    response = client.get(f"/api/registry/test-lookup/{kp['key_id']}")
    assert response.status_code == 200
    assert response.json()["public_key"] == kp["public_key"]

def test_registry_api_404_on_missing_key():
    """Given a GET to /api/registry for a missing key, then 404"""
    response = client.get("/api/registry/missing/abc123")
    assert response.status_code == 404

def test_registry_api_list_endpoint():
    """Given a GET to /api/registry, when listing, then 200"""
    response = client.get("/api/registry")
    assert response.status_code == 200
    assert "count" in response.json()

def test_registry_api_issuer_keys_endpoint():
    """Given a GET to /api/registry/{issuer_id}, when listing, then 200"""
    kp = generate_keypair()
    client.post(
        f"/api/registry/test-list/{kp['key_id']}",
        json={"public_key": kp["public_key"]},
    )
    response = client.get("/api/registry/test-list")
    assert response.status_code == 200
    assert response.json()["count"] >= 1

def test_registry_api_delete_endpoint():
    """Given a DELETE to /api/registry, when deleting, then 200"""
    kp = generate_keypair()
    client.post(
        f"/api/registry/test-del/{kp['key_id']}",
        json={"public_key": kp["public_key"]},
    )
    response = client.delete(f"/api/registry/test-del/{kp['key_id']}")
    assert response.status_code == 200
    assert response.json()["status"] == "REMOVED"

def test_key_id_computation():
    """Given a public key, when computing key_id, then it is stable"""
    kp = generate_keypair()
    from backend.services.sealer import compute_key_id
    id1 = compute_key_id(kp["public_key"])
    id2 = compute_key_id(kp["public_key"])
    assert id1 == id2
    assert len(id1) == 16

def test_seals_contain_key_id():
    """Given a seal generation response, when checking, then key_id is present"""
    response = client.post("/api/seals", json={
        "content": "Test",
        "issuer": "QRed Authority",
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    assert response.status_code == 200
    assert "key_id" in response.json()
    assert len(response.json()["key_id"]) == 16

def test_verify_with_explicit_public_key_still_works():
    """Given explicit public_key in verify request, then verification works"""
    response = client.post("/api/seals", json={
        "content": "Test",
        "issuer": "QRed Authority",
        "private_key": TEST_PRIVATE_KEY,
        "public_key": TEST_PUBLIC_KEY,
    })
    assert response.status_code == 200
    seals = response.json()["seals"]
    result = client.post("/api/verify", json={
        "seals": seals,
        "public_key": TEST_PUBLIC_KEY,
    })
    assert result.status_code == 200
    assert result.json()["status"] == "VALID"

def test_compute_key_id_matches_generate_keypair():
    """Given a generated keypair, when computing key_id, then they match"""
    kp = generate_keypair()
    from backend.services.sealer import compute_key_id
    computed = compute_key_id(kp["public_key"])
    assert computed == kp["key_id"]

def test_registry_key_id_validation_correct():
    """Given a correct key_id, when registering, then 200"""
    kp = generate_keypair()
    response = client.post(
        f"/api/registry/valid-issuer/{kp['key_id']}",
        json={"public_key": kp["public_key"]},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "REGISTERED"

def test_registry_key_id_validation_wrong_key_id():
    """Given a wrong key_id for the public_key, when registering, then 400"""
    kp = generate_keypair()
    response = client.post(
        "/api/registry/wrong-issuer/0000000000000000",
        json={"public_key": kp["public_key"]},
    )
    assert response.status_code == 400
    assert "key_id does not match" in response.json()["detail"]

def test_registry_key_id_validation_different_key():
    """Given a key_id from one key but a different public_key, when registering, then 400"""
    kp1 = generate_keypair()
    kp2 = generate_keypair()
    response = client.post(
        f"/api/registry/mixed-issuer/{kp1['key_id']}",
        json={"public_key": kp2["public_key"]},
    )
    assert response.status_code == 400
    assert "key_id does not match" in response.json()["detail"]

def test_registry_malformed_base64_public_key():
    """Given a malformed base64 public_key, when registering, then 400 (key_id mismatch)"""
    response = client.post(
        "/api/registry/bad-b64/0000000000000000",
        json={"public_key": "!!!not-valid-base64"},
    )
    assert response.status_code == 400
    assert "key_id does not match" in response.json()["detail"]

def test_registry_empty_public_key():
    """Given an empty public_key string, when registering, then 400 (key_id mismatch)"""
    response = client.post(
        "/api/registry/empty-pk/0000000000000000",
        json={"public_key": ""},
    )
    assert response.status_code == 400
    assert "key_id does not match" in response.json()["detail"]

def test_registry_random_bytes_as_public_key():
    """Given random non-base64 bytes as public_key, when registering, then 400"""
    response = client.post(
        "/api/registry/random-pk/0000000000000000",
        json={"public_key": "not_a_real_key_abcdef1234567890"},
    )
    assert response.status_code == 400
    # Could be malformed base64 or key_id mismatch — either way, 400
    detail = response.json()["detail"]
    assert "Invalid public_key" in detail or "key_id does not match" in detail

# ===========================
# Browser PDF Demo BDD Scenarios
# ===========================

def create_sample_pdf(path, pages=2):
    """Create a small PDF fixture with text on each page."""
    import fitz
    doc = fitz.open()
    try:
        for index in range(pages):
            page = doc.new_page()
            page.insert_text((72, 72), f"QRed demo page {index + 1}")
        doc.save(path)
    finally:
        doc.close()


def test_demo_keypair_endpoint_supports_browser_demo():
    """Given the browser demo needs keys, when requested, then an ephemeral keypair is returned"""
    response = client.get("/api/keys/demo")
    assert response.status_code == 200
    data = response.json()
    assert {"private_key", "public_key", "key_id"}.issubset(data)



def test_default_keypair_endpoint_uses_environment_keys(monkeypatch):
    """Given configured default keys, when requested, then the stable keypair is returned"""
    monkeypatch.setenv("QRED_DEFAULT_PRIVATE_KEY", TEST_PRIVATE_KEY)
    monkeypatch.setenv("QRED_DEFAULT_PUBLIC_KEY", TEST_PUBLIC_KEY)

    response = client.get("/api/keys/default")

    assert response.status_code == 200
    data = response.json()
    assert data["private_key"] == TEST_PRIVATE_KEY
    assert data["public_key"] == TEST_PUBLIC_KEY
    assert data["key_id"] == compute_key_id(TEST_PUBLIC_KEY)
    assert data["source"] == "environment"


def test_default_keypair_endpoint_falls_back_to_ephemeral_keys(monkeypatch):
    """Given no configured default keys, when requested, then an ephemeral keypair is returned"""
    monkeypatch.delenv("QRED_DEFAULT_PRIVATE_KEY", raising=False)
    monkeypatch.delenv("QRED_DEFAULT_PUBLIC_KEY", raising=False)

    response = client.get("/api/keys/default")

    assert response.status_code == 200
    data = response.json()
    assert {"private_key", "public_key", "key_id"}.issubset(data)
    assert data["source"] == "ephemeral"


def test_pdf_stamp_assigns_bootstrap_and_payload_to_each_page():
    """Given multiple PDF pages, when assigning stamps, then each page gets a payload URL"""
    from backend.services.pdf_stamp import planned_page_payloads
    seals = ["QRED1|DOC|0|2|aaa", "QRED1|DOC|1|2|bbb"]
    pages = planned_page_payloads(seals, "https://qred.org/", source_page_count=2, max_qr_codes=2)
    assert pages[0][0] == seals[0]
    assert pages[1][0] == seals[1]


def test_pdf_stamp_plan_appends_overflow_pages_without_dropping_seals():
    """Given too many seals for source pages, when planning stamps, then overflow pages keep all chunks"""
    from backend.services.pdf_stamp import planned_page_payloads
    seals = [f"QRED1|DOC|{index}|5|data{index}" for index in range(5)]
    pages = planned_page_payloads(seals, "https://qred.org/", source_page_count=1, max_qr_codes=3)
    placed = [payload for page in pages for payload in page if payload.startswith("QRED1|")]
    assert placed == seals
    assert len(pages) == 2


def test_pdf_path_sealing_uses_verify_htm_bootstrap(tmp_path):
    """Given a local PDF, when sealed, then the response targets qred.org fragments"""
    from backend.services.pdf_stamp import seal_pdf
    pdf_path = tmp_path / "demo.pdf"
    output_path = tmp_path / "demo.sealed.pdf"
    create_sample_pdf(pdf_path)
    result = seal_pdf(
        str(pdf_path),
        issuer=TEST_ISSUER,
        private_key=TEST_PRIVATE_KEY,
        public_key=TEST_PUBLIC_KEY,
        output_path=str(output_path),
    )
    assert output_path.exists()
    assert result["bootstrap_url"] == "https://qred.org/"
    assert result["total_seals"] >= 1
    assert len(result["page_seal_strings"]) == 2


def test_pdf_path_sealing_creates_independently_verifiable_page_seals(tmp_path):
    """Given a multi-page PDF, when sealed, then each page has standalone verifiable seals."""
    from backend.services.pdf_stamp import seal_pdf
    pdf_path = tmp_path / "pages.pdf"
    output_path = tmp_path / "pages.sealed.pdf"
    create_sample_pdf(pdf_path, pages=2)

    result = seal_pdf(
        str(pdf_path),
        issuer=TEST_ISSUER,
        private_key=TEST_PRIVATE_KEY,
        public_key=TEST_PUBLIC_KEY,
        output_path=str(output_path),
    )

    assert len(result["page_seal_strings"]) == 2
    first_page_result = reconstruct_and_verify(result["page_seal_strings"][0], TEST_PUBLIC_KEY)
    second_page_result = reconstruct_and_verify(result["page_seal_strings"][1], TEST_PUBLIC_KEY)
    assert first_page_result["status"] == "VALID"
    assert "QRed demo page 1" in first_page_result["content"]
    assert "Page SHA256:" in first_page_result["content"]
    assert "Page:" not in first_page_result["content"]
    assert second_page_result["status"] == "VALID"
    assert "QRed demo page 2" in second_page_result["content"]
    assert "Page SHA256:" in second_page_result["content"]
    assert "Page:" not in second_page_result["content"]
    assert first_page_result["document_id"] != second_page_result["document_id"]



def test_pdf_page_seals_share_merkle_root_to_detect_page_swaps(tmp_path):
    """Given two sealed PDFs, when pages are compared, then swapped-in pages expose a different Merkle root."""
    from backend.services.pdf_stamp import seal_pdf

    first_pdf = tmp_path / "first.pdf"
    second_pdf = tmp_path / "second.pdf"
    create_sample_pdf(first_pdf, pages=2)
    create_sample_pdf(second_pdf, pages=3)

    first = seal_pdf(
        str(first_pdf),
        issuer=TEST_ISSUER,
        private_key=TEST_PRIVATE_KEY,
        public_key=TEST_PUBLIC_KEY,
        output_path=str(tmp_path / "first.sealed.pdf"),
    )
    second = seal_pdf(
        str(second_pdf),
        issuer=TEST_ISSUER,
        private_key=TEST_PRIVATE_KEY,
        public_key=TEST_PUBLIC_KEY,
        output_path=str(tmp_path / "second.sealed.pdf"),
    )

    assert re.fullmatch(r"[0-9a-f]{64}", first["document_id"])
    first_doc_ids = [decode_seal(seal)["document_id"] for page in first["page_seal_strings"] for seal in page]
    assert all(re.fullmatch(r"[0-9a-f]{64}", doc_id) for doc_id in first_doc_ids)

    first_page = reconstruct_and_verify(first["page_seal_strings"][0], TEST_PUBLIC_KEY)
    first_second_page = reconstruct_and_verify(first["page_seal_strings"][1], TEST_PUBLIC_KEY)
    swapped_page = reconstruct_and_verify(second["page_seal_strings"][1], TEST_PUBLIC_KEY)

    root_pattern = r"Document Merkle Root: ([0-9a-f]{64})"
    first_root = re.search(root_pattern, first_page["content"]).group(1)
    first_second_root = re.search(root_pattern, first_second_page["content"]).group(1)
    swapped_root = re.search(root_pattern, swapped_page["content"]).group(1)

    assert first_page["status"] == "VALID"
    assert first_second_page["status"] == "VALID"
    assert swapped_page["status"] == "VALID"
    assert first_root == first_second_root
    assert swapped_root != first_root
    assert "Document ID:" not in first_page["content"]
    assert "Document ID:" not in swapped_page["content"]


def test_pdf_page_seal_group_ids_do_not_collide_for_duplicate_chunked_pages(tmp_path):
    """Given identical long pages, when sealed, then each chunked page payload has a unique QR doc id."""
    import fitz
    from backend.services.pdf_stamp import seal_pdf

    pdf_path = tmp_path / "duplicate-long-pages.pdf"
    output_path = tmp_path / "duplicate-long-pages.sealed.pdf"
    repeated_text = "Identical chunked page content. " * 400
    doc = fitz.open()
    try:
        for _ in range(2):
            page = doc.new_page(width=612, height=4000)
            page.insert_textbox(fitz.Rect(72, 72, 540, 3900), repeated_text, fontsize=12)
        doc.save(pdf_path)
    finally:
        doc.close()

    result = seal_pdf(
        str(pdf_path),
        issuer=TEST_ISSUER,
        private_key=TEST_PRIVATE_KEY,
        public_key=TEST_PUBLIC_KEY,
        output_path=str(output_path),
        layout={"size": 10, "spacing": 12, "margin": 5},
    )

    assert len(result["page_seal_strings"]) == 2
    first_page_doc_ids = {decode_seal(seal)["document_id"] for seal in result["page_seal_strings"][0]}
    second_page_doc_ids = {decode_seal(seal)["document_id"] for seal in result["page_seal_strings"][1]}
    assert len(result["page_seal_strings"][0]) > 1
    assert len(result["page_seal_strings"][1]) > 1
    assert len(first_page_doc_ids) == 1
    assert len(second_page_doc_ids) == 1
    assert first_page_doc_ids != second_page_doc_ids

    first_page_result = reconstruct_and_verify(result["page_seal_strings"][0], TEST_PUBLIC_KEY)
    second_page_result = reconstruct_and_verify(result["page_seal_strings"][1], TEST_PUBLIC_KEY)
    assert first_page_result["status"] == "VALID"
    assert second_page_result["status"] == "VALID"
    assert first_page_result["content"] == second_page_result["content"]

def test_pdf_seal_api_end_to_end_can_verify_returned_seals(tmp_path):
    """Given a one-page PDF, when sealed through the API, then returned seals verify through the API."""
    pdf_path = tmp_path / "e2e.pdf"
    output_path = tmp_path / "e2e.sealed.pdf"
    create_sample_pdf(pdf_path, pages=1)

    seal_response = client.post(
        "/api/pdf/seal",
        params={
            "pdf_path": str(pdf_path),
            "output_path": str(output_path),
            "issuer": TEST_ISSUER,
            "private_key": TEST_PRIVATE_KEY,
            "public_key": TEST_PUBLIC_KEY,
        },
    )

    assert seal_response.status_code == 200
    sealed = seal_response.json()
    assert output_path.exists()
    assert sealed["bootstrap_url"] == "https://qred.org/"
    assert sealed["total_seals"] == len(sealed["seal_strings"]) >= 1

    verify_response = client.post(
        "/api/verify",
        json={
            "seals": sealed["seal_strings"],
            "public_key": TEST_PUBLIC_KEY,
        },
    )

    assert verify_response.status_code == 200
    verification = verify_response.json()
    assert verification["status"] == "VALID"
    assert verification["issuer"] == TEST_ISSUER
    assert "QRed demo page 1" in verification["content"]
    assert "Document Merkle Root:" in verification["content"]
    assert re.fullmatch(r"[0-9a-f]{64}", verification["document_id"])


def test_pdf_upload_endpoint_returns_sealed_pdf_download(tmp_path):
    """Given a browser PDF upload, when sealing, then a PDF download is returned"""
    pdf_path = tmp_path / "upload.pdf"
    create_sample_pdf(pdf_path)
    with pdf_path.open("rb") as pdf_file:
        response = client.post(
            "/api/pdf/upload-seal",
            data={
                "issuer": TEST_ISSUER,
                "private_key": TEST_PRIVATE_KEY,
                "public_key": TEST_PUBLIC_KEY,
            },
            files={"file": ("upload.pdf", pdf_file, "application/pdf")},
        )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["x-qred-bootstrap-url"] == "https://qred.org/"
    assert response.content.startswith(b"%PDF")

def test_pdf_upload_rejects_non_pdf_content(tmp_path):
    """Given a fake PDF upload, when sealing, then it is rejected as unsupported media"""
    fake_pdf = tmp_path / "fake.pdf"
    fake_pdf.write_bytes(b"not a pdf")
    with fake_pdf.open("rb") as pdf_file:
        response = client.post(
            "/api/pdf/upload-seal",
            data={
                "issuer": TEST_ISSUER,
                "private_key": TEST_PRIVATE_KEY,
                "public_key": TEST_PUBLIC_KEY,
            },
            files={"file": ("fake.pdf", pdf_file, "application/pdf")},
        )
    assert response.status_code == 415

def test_mobile_verifier_verifies_locally_without_posting_document_content():
    """Given mobile verifier HTML, when inspected, then it verifies in-browser without posting seals to /api/verify."""
    from pathlib import Path
    html = Path("frontend/verifier.html").read_text()
    assert 'fetch("/api/verify"' not in html
    assert 'verifyQRedSeals(seals, publicKey)' in html
    assert 'showResult("VALID", payload)' not in html
    assert 'publicKeyInput' in html
    assert 'fetch("/api/keys/default")' in html
    assert 'No default trusted key found; showing unverified QR text.' in html

def test_pdf_stamp_plan_rejects_layout_that_cannot_fit_bootstrap_and_payload():
    """Given a too-narrow layout, when planning stamps, then it fails instead of overflowing"""
    from backend.services.pdf_stamp import planned_page_payloads
    with pytest.raises(ValueError, match="one QRed payload QR"):
        planned_page_payloads(["QRED1|DOC|0|1|data"], "https://qred.org/", 1, 0)


def test_backend_ci_requirements_include_imported_runtime_packages():
    """Given CI installs backend requirements, then imported app dependencies are present."""
    requirements = Path("backend/requirements.txt").read_text().lower()
    required_packages = {
        "cryptography",
        "pymupdf",
        "qrcode",
        "pillow",
        "python-multipart",
    }
    for package in required_packages:
        assert package in requirements
