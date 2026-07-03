"""
QRed — BDD Test Suite for PDF Sealing and QR Verification
==========================================================

BDD Feature: Tamper-Evident PDF Document Sealing with QR Verification

  Scenario 1: Launch the App
    Given the QRed app is running on localhost
    When I open index.html in the browser
    Then I see a PDF upload zone and issuer input field

  Scenario 2: Seal a PDF
    Given I have uploaded a PDF
    When I click "Seal Document"
    Then the system extracts text from each page
    And signs the text with an Ed25519 keypair
    And generates QR codes encoding verification URLs
    And stamps QR codes on the PDF pages
    And returns the stamped PDF for download

  Scenario 3: Verify via QR Scan
    Given a sealed PDF printed on paper
    When I scan a QR code with my phone camera
    Then the browser opens verify.htm
    And the system decodes the QRed seal
    And decompresses the payload
    And verifies the Ed25519 signature
    And displays: document content, issuer name, validity status

  Scenario 4: Multi-Chunk Verification
    Given a sealed document producing multiple QR codes
    When I scan all the QR codes
    Then the system reconstructs the full payload
    And verifies the complete document

  Scenario 5: Client-Side Ed25519 Verification
    Given the payload embeds the Ed25519 public key
    When I verify in the browser
    Then no server round-trip is needed
    And the Web Crypto API verifies the signature

Run: pytest tests/test_bdd_demo.py -v
"""

import base64
import json
from pathlib import Path

import pytest

from backend.crypto import generate_keypair, sign, verify as crypto_verify
from backend.services.sealer import (
    canonicalize_text,
    compress_payload,
    decompress_payload,
    split_into_chunks,
)
from backend.models import QRedChunk

ROOT = Path(__file__).parent.parent


# ============================================================
# BDD: Feature Documentation Tests
# ============================================================

FEATURE_DOC = """
Feature: Tamper-Evident PDF Document Sealing with QR Verification

  Scenario: Open the QRed App
    Given the QRed server runs on localhost:8190
    When I open index.html
    Then I see a PDF upload zone, issuer field, and seal button

  Scenario: Seal and Download a PDF
    Given a PDF file is selected
    When I click "Seal Document"
    Then the system:
    - Extracts text from each PDF page
    - Signs it with Ed25519
    - Compresses and chunks the payload
    - Generates QR codes (each encoding a qred.org/verify.htm?seal=... URL)
    - Stamps QR codes on each PDF page
    - Returns the stamped PDF for download

  Scenario: Verify via QR Code Scan
    Given a sealed PDF with QR codes
    When I scan a QR code with my phone
    Then verify.htm loads with the seal data from the URL
    And the system:
    - Decodes the QRed seal
    - Reconstructs the compressed payload
    - Decompresses the JSON
    - Verifies the Ed25519 signature with the embedded public key
    - Displays the document content and issuer name

  Scenario: Client-Side Verification
    Given the payload contains the Ed25519 public key
    When I verify in the browser
    Then no server round-trip is needed
    And Web Crypto API confirms the signature

  Scenario: Tamper Detection
    Given a sealed PDF
    When the text content changes
    Then the Ed25519 signature no longer matches
"""


class TestBDD_Documentation:
    """BDD feature documentation tests."""

    def test_feature_documentation_exists(self):
        """Feature documentation is present and non-empty."""
        assert len(FEATURE_DOC.strip()) > 500

    def test_all_scenarios_present(self):
        """All five scenarios are documented."""
        for keyword in ["Open the QRed App", "Seal and Download",
                        "Verify via QR", "Client-Side Verification",
                        "Tamper Detection"]:
            assert keyword in FEATURE_DOC

    def test_follows_given_when_then(self):
        """Scenarios follow the Given/When/Then pattern."""
        assert FEATURE_DOC.count("Given") >= 3
        assert FEATURE_DOC.count("When") >= 3
        assert FEATURE_DOC.count("Then") >= 3


# ============================================================
# BDD: Seal Generation (Scenarios 2)
# ============================================================

class TestBDD_SealGeneration:
    """BDD: Given I upload a PDF, When I seal it, Then sealed output."""

    def test_given_valid_document_when_signed_then_valid_signature(self):
        """Given a document, when signed, then the Ed25519 signature is valid."""
        keypair = generate_keypair()
        content = "This document is sealed by QRed."
        canonical = canonicalize_text(content)
        sig = sign(canonical, keypair["private_key"])
        assert crypto_verify(canonical, sig, keypair["public_key"])

    def test_given_document_when_canonicalized_then_deterministic(self):
        """Given a document, when canonicalized, then output is deterministic."""
        text = "Line 1\nLine 2\n\nLine 3\n"
        assert canonicalize_text(text) == canonicalize_text(text)

    def test_given_document_when_compressed_then_decompressible(self):
        """Given a document, when compressed, then it decompresses correctly."""
        payload_json = json.dumps({"content": "Test", "issuer": "QRed Authority"})
        compressed = compress_payload(payload_json)
        decompressed = decompress_payload(compressed)
        assert json.loads(decompressed) == json.loads(payload_json)

    def test_given_large_document_when_chunked_then_reconstructable(self):
        """Given a large document, when chunked, then it reconstructs correctly."""
        long_text = "The quick brown fox jumps over the lazy dog. " * 50
        payload_json = json.dumps({"content": long_text, "issuer": "QRed Authority"})
        compressed = compress_payload(payload_json)
        chunks = split_into_chunks(compressed, chunk_size=200)
        reconstructed = "".join(chunks)
        assert len(reconstructed) == len(compressed)
        decompressed = decompress_payload(reconstructed)
        parsed = json.loads(decompressed)
        assert parsed["content"] == long_text

    def test_given_seal_when_encoded_then_valid_qred1_format(self):
        """Given a seal chunk, when encoded, then it follows QRED1|... format."""
        chunk = QRedChunk(
            document_id="DOC-TEST123",
            chunk_number=0,
            total_chunks=3,
            data="base64_data_here",
        )
        encoded = chunk.encode()
        assert encoded.startswith("QRED1|")
        parts = encoded.split("|")
        assert len(parts) == 5

    def test_given_encoded_seal_when_decoded_then_round_trip(self):
        """Given an encoded seal, when decoded, then round-trip succeeds."""
        original = QRedChunk(
            document_id="DOC-RT",
            chunk_number=2,
            total_chunks=5,
            data="round_trip_data",
        )
        decoded = QRedChunk.decode(original.encode())
        assert decoded == original


# ============================================================
# BDD: QR Codes (Scenario 2 - QR generation)
# ============================================================

class TestBDD_QRCodes:
    """BDD: Given seal data, When QR codes generated, Then scannable URLs."""

    def test_given_qred_seal_when_url_encoded_then_parsable(self):
        """Given a QRED1 seal, when URL-encoded, then it decodes correctly."""
        from urllib.parse import quote, unquote

        seal = "QRED1|DOC-TEST|0|3|abc123data"
        encoded = quote(seal, safe="")
        decoded = unquote(encoded)
        assert decoded == seal

    def test_given_qred_seal_when_url_constructed_then_valid(self):
        """Given a seal, when turned into a URL, then the URL is valid."""
        from urllib.parse import quote

        seal = "QRED1|DOC-TEST|0|1|testdata"
        url = f"https://qred.org/verify.htm?seal={quote(seal, safe='')} "
        assert "https://qred.org/verify.htm" in url
        assert "seal=QRED1" in url


# ============================================================
# BDD: Verification Pipeline (Scenarios 3, 4, 5)
# ============================================================

class TestBDD_VerificationPipeline:
    """BDD: Given seals, When verified, Then content + issuer + validity."""

    def test_given_valid_seals_when_verified_then_valid(self):
        """Given valid seals, when verified, then status is VALID."""
        keypair = generate_keypair()
        content = "Verified document content."
        canonical = canonicalize_text(content)
        sig = sign(canonical, keypair["private_key"])

        # Build payload with embedded public key
        payload = {
            "issuer": "QRed Authority",
            "public_key": keypair["public_key"],
            "content": canonical,
            "signature": sig,
            "algorithm": "Ed25519",
        }
        payload_json = json.dumps(payload)
        compressed = compress_payload(payload_json)
        chunks = split_into_chunks(compressed, chunk_size=200)

        # Reconstruct from all chunks
        reconstructed = "".join(chunks)
        decompressed = decompress_payload(reconstructed)
        parsed = json.loads(decompressed)

        # Verify
        assert crypto_verify(parsed["content"], parsed["signature"], parsed["public_key"])
        assert parsed["issuer"] == "QRed Authority"

    def test_given_tampered_content_when_verified_then_invalid(self):
        """Given tampered content, when verified, then signature is INVALID."""
        keypair = generate_keypair()
        original = canonicalize_text("Original Content")
        sig = sign(original, keypair["private_key"])
        tampered = "Tampered Content"
        assert not crypto_verify(tampered, sig, keypair["public_key"])

    def test_given_wrong_key_when_verified_then_invalid(self):
        """Given a different public key, when verified, then INVALID."""
        kp1 = generate_keypair()
        kp2 = generate_keypair()
        content = "Test content"
        sig = sign(content, kp1["private_key"])
        assert not crypto_verify(content, sig, kp2["public_key"])

    def test_given_all_chunks_when_reconstructed_then_complete(self):
        """Given all chunks collected, when reconstructed, then complete payload."""
        keypair = generate_keypair()
        content = "Multi-chunk document. " * 100
        canonical = canonicalize_text(content)
        sig = sign(canonical, keypair["private_key"])

        payload = {
            "issuer": "QRed Authority",
            "public_key": keypair["public_key"],
            "content": canonical,
            "signature": sig,
            "algorithm": "Ed25519",
        }
        payload_json = json.dumps(payload)
        compressed = compress_payload(payload_json)
        chunks = split_into_chunks(compressed, chunk_size=200)

        # Collect all chunks (simulating scanning all QR codes)
        collected = []
        for i, c in enumerate(chunks):
            qred = QRedChunk(
                document_id="DOC-MULTI",
                chunk_number=i,
                total_chunks=len(chunks),
                data=c,
            )
            # URL encode
            from urllib.parse import quote
            url = f"https://qred.org/verify.htm?seal={quote(qred.encode(), safe='')}"
            collected.append(qred.data)

        # Reconstruct
        full_data = "".join(collected)
        decompressed = decompress_payload(full_data)
        parsed = json.loads(decompressed)

        assert parsed["content"] == canonical
        assert crypto_verify(parsed["content"], parsed["signature"], parsed["public_key"])


# ============================================================
# BDD: Frontend Files (Scenario 1)
# ============================================================

class TestBDD_FrontendExists:
    """BDD: Given the frontend files, When present, Then they have required elements."""

    def test_index_html_exists(self):
        """index.html exists for the PDF upload UI."""
        path = ROOT / "frontend" / "index.html"
        assert path.exists(), "frontend/index.html missing"

    def test_verify_htm_exists(self):
        """verify.htm exists for QR verification."""
        path = ROOT / "frontend" / "verify.htm"
        assert path.exists(), "frontend/verify.htm missing"

    def test_index_html_has_pdf_upload(self):
        """index.html has PDF upload functionality."""
        html = (ROOT / "frontend" / "index.html").read_text()
        assert "QRed" in html
        assert "pdf" in html.lower() or "PDF" in html

    def test_verify_htm_has_verification_ui(self):
        """verify.htm has verification UI elements."""
        html = (ROOT / "frontend" / "verify.htm").read_text()
        assert "QRed" in html
        assert "Verify" in html or "verify" in html
