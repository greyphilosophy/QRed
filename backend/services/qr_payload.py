"""QR transport helpers for scanner-safe QRed payloads."""

from __future__ import annotations

from qrcode import base, exceptions, util

VISIBLE_QR_URL = "QRED.ORG"
HIDDEN_PAYLOAD_LENGTH_BYTES = 2


def _data_bit_limit(version: int, error_correction: int) -> int:
    return sum(block.data_count * 8 for block in base.rs_blocks(version, error_correction))


def _visible_url_buffer(version: int) -> util.BitBuffer:
    data = util.QRData(VISIBLE_QR_URL, mode=util.MODE_ALPHA_NUM)
    buffer = util.BitBuffer()
    buffer.put(data.mode, 4)
    buffer.put(len(data), util.length_in_bits(data.mode, version))
    data.write(buffer)
    return buffer


def encoded_hidden_payload_bytes(payload: str | bytes) -> bytes:
    raw = payload.encode("utf-8") if isinstance(payload, str) else bytes(payload)
    if len(raw) > 65535:
        raise ValueError("Hidden QRed payload is too large")
    return len(raw).to_bytes(HIDDEN_PAYLOAD_LENGTH_BYTES, "big") + raw


def scanner_safe_bit_buffer(version: int, error_correction: int, payload: str | bytes) -> util.BitBuffer:
    """Build QR data bits whose public data is only QRED.ORG.

    The QR header character count covers only the short visible URL, then the
    standard QR terminator is emitted. QRed-specific payload bytes are stored in
    remaining data capacity after the terminator for custom raw-module readers.
    """
    bit_limit = _data_bit_limit(version, error_correction)
    buffer = _visible_url_buffer(version)
    if len(buffer) > bit_limit:
        raise exceptions.DataOverflowError("Visible URL exceeds QR capacity")

    # QR terminator: up to four zero bits immediately after the visible URL.
    for _ in range(min(bit_limit - len(buffer), 4)):
        buffer.put_bit(False)

    delimit = len(buffer) % 8
    if delimit:
        for _ in range(8 - delimit):
            buffer.put_bit(False)

    hidden = encoded_hidden_payload_bytes(payload)
    if len(buffer) + (len(hidden) * 8) > bit_limit:
        raise exceptions.DataOverflowError(
            f"Hidden QRed payload size ({len(hidden)} bytes) exceeds QR capacity"
        )
    for byte in hidden:
        buffer.put(byte, 8)

    bytes_to_fill = (bit_limit - len(buffer)) // 8
    for index in range(bytes_to_fill):
        buffer.put(util.PAD0 if index % 2 == 0 else util.PAD1, 8)
    return buffer


def create_scanner_safe_data(version: int, error_correction: int, payload: str | bytes) -> list[int]:
    buffer = scanner_safe_bit_buffer(version, error_correction, payload)
    return util.create_bytes(buffer, base.rs_blocks(version, error_correction))


def extract_hidden_payload_from_buffer(buffer: util.BitBuffer, version: int) -> bytes:
    """Test/custom-reader helper to recover bytes written after the terminator."""
    start = len(_visible_url_buffer(version)) + 4
    start += (-start) % 8
    data = bytes(buffer.buffer[start // 8:])
    if len(data) < HIDDEN_PAYLOAD_LENGTH_BYTES:
        return b""
    length = int.from_bytes(data[:HIDDEN_PAYLOAD_LENGTH_BYTES], "big")
    offset = HIDDEN_PAYLOAD_LENGTH_BYTES
    return data[offset:offset + length]
