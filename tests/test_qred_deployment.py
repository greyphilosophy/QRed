"""Manual test script for QRed deployment.
Run this against a local QRed instance to verify the full seal flow.
Usage: python3 test_qred_deployment.py --base-url http://localhost:5173

Or use this as a checklist for manual testing of qred.org.
"""

import subprocess
import os
import tempfile
import sys

try:
    from PIL import Image
    import io as _io
    import reportlab
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas as rl_canvas
except ImportError:
    print("Missing dependencies. Install with:")
    print("  pip3 install reportlab pillow")
    sys.exit(1)

BASE_URL = sys.argv[1] if len(sys) > 1 else "http://localhost:5173"


def create_simple_pdf(path):
    """Create a minimal test PDF."""
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=letter)
    c.drawString(100, 700, "QRed Manual Test Document")
    c.setFont("Helvetica", 24)
    c.drawString(100, 650, "Testing seal functionality")
    c.save()
    with open(path, "wb") as f:
        f.write(buf.getvalue())
    return buf.getvalue()


def create_image_only_pdf(path):
    """Create a PDF with actual raster image (no text)."""
    img_buf = io.BytesIO()
    img = Image.new("RGB", (200, 200), color=(200, 200, 200))
    img.save(img_buf, format="PNG")
    img_buf.seek(0)

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False, mode="wb") as png_tmp:
        png_tmp.write(img_buf.read())
        png_path = png_tmp.name

    try:
        buf = io.BytesIO()
        c = rl_canvas.Canvas(buf, pagesize=letter)
        c.drawImage(png_path, x=50, y=50, width=500, height=700, mask="auto")
        c.save()
        with open(path, "wb") as f:
            f.write(buf.getvalue())
        return buf.getvalue()
    finally:
        try:
            os.unlink(png_path)
        except:
            pass


def create_corrupt_pdf(path):
    """Create a corrupt PDF for error handling tests."""
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=letter)
    c.drawString(100, 700, "Normal content")
    c.save()
    data = buf.getvalue()
    # Corrupt the trailer
    corrupted = data[:-20].replace(b"%%EOF", b"CORRUPTED_TRAILER")
    with open(path, "wb") as f:
        f.write(corrupted)
    return corrupted


def create_truncated_pdf(path):
    """Create a truncated PDF."""
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=letter)
    c.drawString(100, 700, "Normal content here")
    c.save()
    data = buf.getvalue()
    truncated = data[:len(data)//2]  # Cut in half
    with open(path, "wb") as f:
        f.write(truncated)
    return truncated


def test_seal_upload(pdf_path):
    """Test the upload-seal API endpoint."""
    result = subprocess.run(
        [
            "curl", "-s", "-D", "/tmp/seal_headers.txt",
            "-X", "POST",
            "-F", "issuer=Manual Test",
            "-F", "private_key=txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=",
            "-F", "public_key=eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=",
            "-F", f"file=@{pdf_path}",
            f"{BASE_URL}/api/pdf/upload-seal",
            "-o", "/tmp/sealed_output.pdf"
        ],
        capture_output=True, text=True,
        timeout=30
    )
    
    print(f"\n=== Seal upload: {os.path.basename(pdf_path)} ===")
    print(f"HTTP status: {result.returncode}")
    
    if os.path.exists("/tmp/seal_headers.txt"):
        with open("/tmp/seal_headers.txt") as f:
            headers = f.read()
        for h in ["QRed", "Content-Type", "Content-Length"]:
            for line in headers.split('\n'):
                if h.lower() in line.lower():
                    print(f"  {line.strip()}")
    
    if os.path.exists("/tmp/sealed_output.pdf"):
        size = os.path.getsize("/tmp/sealed_output.pdf")
        if size > 100:
            with open("/tmp/sealed_output.pdf", "rb") as f:
                preview = f.read()
            if preview.startswith(b'%PDF-'):
                print(f"  ✅ Sealed PDF returned ({size} bytes)")
            else:
                print(f"  ❌ Not a PDF (error response?)")
                print(f"  Response: {preview.decode('utf-8', errors='replace')[:200]}")
        else:
            print(f"  ❌ Unexpected size ({size} bytes)")
    else:
        print("  ❌ No output file")


def test_key_loading():
    """Test that /api/keys/default works."""
    result = subprocess.run(
        ["curl", "-s", f"{BASE_URL}/api/keys/default"],
        capture_output=True, text=True
    )
    print("\n=== Key loading ===")
    if result.stdout:
        print(f"  ✅ Keys loaded: {result.stdout[:200]}")
    else:
        print("  ❌ No response")


def main():
    print(f"Testing QRed at: {BASE_URL}")
    
    test_key_loading()
    
    # Test 1: Normal PDF
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        normal_pdf = f.name
    create_simple_pdf(normal_pdf)
    test_seal_upload(normal_pdf)
    os.unlink(normal_pdf)
    
    # Test 2: Image-only PDF
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        image_pdf = f.name
    create_image_only_pdf(image_pdf)
    test_seal_upload(image_pdf)
    os.unlink(image_pdf)
    
    # Test 3: Corrupt PDF
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        corrupt_pdf = f.name
    create_corrupt_pdf(corrupt_pdf)
    test_seal_upload(corrupt_pdf)
    os.unlink(corrupt_pdf)
    
    # Test 4: Truncated PDF
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        truncated_pdf = f.name
    create_truncated_pdf(truncated_pdf)
    test_seal_upload(truncated_pdf)
    os.unlink(truncated_pdf)


if __name__ == "__main__":
    main()