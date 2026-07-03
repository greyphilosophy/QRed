#!/usr/bin/env python3
"""QRed Demo - Walks through the full seal to verify flow.

Usage:
    python demo.py          # Run the demo
    python demo.py api      # Show API curl examples
"""
import sys
import textwrap

from backend.crypto import generate_keypair
from backend.services.sealer import create_seals
from backend.services.verifier import reconstruct_and_verify


def run_demo():
    print("=" * 60)
    print("  QRed - Tamper-Evident Document Sealing")
    print("  Interactive Demo")
    print("=" * 60)
    print()

    # Step 1: Generate a keypair
    print("[1/5] Generating Ed25519 keypair...")
    kp = generate_keypair()
    print(f"      Key ID: {kp['key_id']}")
    print()

    # Step 2: Create a sample document
    document_text = textwrap.dedent("""\
        QRed Inc. - Certificate of Authenticity
        ---------------------------------------
        This certifies that the attached document has been
        tamper-sealed using the QRed standard.
        Document ID: DOC-2026-001
        Issued by: QRed Authority
        """).strip()

    print("[2/5] Creating sample document...")
    print(f"      Length: {len(document_text)} chars")
    print()

    # Step 3: Generate seals
    print("[3/5] Sealing document with QRed seals...")
    result = create_seals(
        document_text=document_text,
        issuer="QRed Authority",
        private_key=kp["private_key"],
        public_key=kp["public_key"],
    )
    print(f"      Document ID: {result.document_id}")
    print(f"      Total seals: {result.total_chunks}")
    print()

    # Step 4: Show seal strings (QR-ready)
    print("[4/5] Generated seal strings (QR-ready):")
    for i, chunk in enumerate(result.chunks):
        encoded = chunk.encode()
        preview = encoded[:60] + ("..." if len(encoded) > 60 else "")
        print(f"  Seal {i+1}: {preview}")
    print()

    # Step 5: Verify
    print("[5/5] Verifying seals...")
    seals = [c.encode() for c in result.chunks]
    verification = reconstruct_and_verify(seals, expected_public_key=kp["public_key"])

    print(f"  Status:  {verification['status']}")
    print(f"  Issuer:  {verification.get('issuer', 'N/A')}")
    print(f"  Doc ID:  {verification.get('document_id', 'N/A')}")
    print()

    print("Done!")
    print("  The document was successfully sealed and verified.")
    print("  Each seal string can be QR-encoded and printed on the")
    print("  document for recipient verification.")


def show_api_examples():
    print("=" * 60)
    print("  QRed API Usage Examples")
    print("=" * 60)
    print()
    print("  Start the server:")
    print("  uvicorn backend.app:create_app --factory --port 8190")
    print()
    print("  Generate seals for a document:")
    print("  POST /api/seals")
    print("  Body: {content, issuer, private_key, public_key}")
    print()
    print("  Verify seals:")
    print("  POST /api/verify")
    print("  Body: {seals: [\"https://qred.org/#QRED1?...\", ...]}")
    print()
    print("  Register an issuer key:")
    print("  POST /api/registry/{issuer_id}/{key_id}")
    print("  Body: {public_key: \"...\"}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "api":
        show_api_examples()
    else:
        run_demo()