"""QRed Core Data Models — frozen dataclasses with pure functions."""

import json
from dataclasses import dataclass, field
from typing import Optional

FORMAT_ID = "QRED1"


@dataclass(frozen=True)
class QRedChunk:
    """A single chunk of a QRed payload for QR encoding."""
    format_id: str = FORMAT_ID
    document_id: str = ""
    chunk_number: int = 0
    total_chunks: int = 0
    data: str = ""

    def encode(self) -> str:
        """Encode chunk into the QRed seal format string or fragment URL."""
        if self.data.startswith("http://") or self.data.startswith("https://"):
            return self.data
        return f"{self.format_id}|{self.document_id}|{self.chunk_number}|{self.total_chunks}|{self.data}"

    @classmethod
    def decode(cls, encoded: str) -> "QRedChunk":
        """Decode a QRed seal string or fragment URL back into a chunk."""
        if "#QRED1?" in encoded or encoded.startswith("QRED1?"):
            from urllib.parse import parse_qs

            fragment = encoded.split("#", 1)[1] if "#" in encoded else encoded
            params = {key: values[0] for key, values in parse_qs(fragment[len("QRED1?"):], keep_blank_values=True).items()}
            return cls(
                format_id="QRED1",
                document_id=params.get("doc", ""),
                chunk_number=int(params.get("i", "0")),
                total_chunks=int(params.get("n", "0")),
                data=encoded,
            )
        parts = encoded.split("|", 4)
        if len(parts) < 5:
            raise ValueError(f"Invalid QRed chunk format: {encoded}")
        fmt_id, doc_id, chunk_num, total, data = parts
        return cls(
            format_id=fmt_id,
            document_id=doc_id,
            chunk_number=int(chunk_num),
            total_chunks=int(total),
            data=data,
        )


@dataclass
class VerificationResult:
    """The result of verifying a QRed document."""
    status: str = "ERROR"  # VALID, INVALID, INCOMPLETE, ERROR
    error_message: str = ""
    issuer: str = ""
    document_id: str = ""
    timestamp: str = ""
    content: str = ""
    key_id: str = ""

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "issuer": self.issuer,
            "document_id": self.document_id,
            "timestamp": self.timestamp,
            "content": self.content,
            "key_id": self.key_id,
            "error_message": self.error_message,
        }


@dataclass
class SealGenerationResult:
    """Result of generating QRed seals for a document."""
    document_id: str = ""
    bootstrap_url: str = ""
    chunks: list = field(default_factory=list)
    payload_json: str = ""
    total_chunks: int = 0
    issuer: str = ""
    key_id: str = ""

    def to_dict(self) -> dict:
        return {
            "document_id": self.document_id,
            "bootstrap_url": self.bootstrap_url,
            "chunks": [c.encode() for c in self.chunks],
            "total_chunks": self.total_chunks,
            "payload_json": self.payload_json,
            "issuer": self.issuer,
            "key_id": self.key_id,
        }