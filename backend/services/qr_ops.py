"""QR code generation — generate PNG QR code images from data strings."""

import base64
import io

import qrcode
from PIL import Image


def generate_qr_image(data: str) -> bytes:
    """Generate a QR code PNG image for the given data string.

    Args:
        data: String to encode in the QR code

    Returns:
        PNG image bytes
    """
    qr = qrcode.make(data)
    # Convert to PIL Image to get PNG bytes
    img = Image.frombytes("RGB", qr.size, bytes(qr.data))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def generate_qr_url(base_url: str, seal_data: str) -> str:
    """Build a verification URL with the seal data as a base64url query param."""
    encoded = base64.urlsafe_b64encode(seal_data.encode("utf-8")).decode("utf-8")
    return f"{base_url}?seal={encoded}"
