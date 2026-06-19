"""QRed Core Data Models — frozen dataclasses with pure functions."""

import hashlib
import json
import time
from dataclasses import dataclass, field, asdict
from typing import Optional

FORMAT_ID = "QRED1"


@dataclass(frozen=True)
class SignerKeyPair:
    """Represents an issuer's public/private key pair."""
    public_key: str
    private_key: str
    issuer_id: str
    algorithm: str = "Ed25519"

    def to_dict(self) -> dict:
        return {
            "issuer_id": self.issuer_id,
            "public_key": self.public_key,
            "algorithm": self.algorithm,
        }


@dataclass(frozen=True)
class DocumentPayload:
    """The signed payload for a QRed document."""
    version: str = "1"
    issuer: str = ""
    document_id: str = ""
    timestamp: str = ""
    content: str = ""
    signature: str = ""
    algorithm: str = "Ed25519"
    public_key: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), separators=(", ", ":"))

    def to_canonical_json(self) -> str:
        """Deterministic JSON for signing — sorted keys, no spaces after colons."""
        return json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":"))


@dataclass(frozen=True)
class QRedChunk:
    """A single chunk of a QRed payload for QR encoding."""
    format_id: str = FORMAT_ID
    document_id: str = ""
    chunk_number: int = 0
    total_chunks: int = 0
    data: str = ""

    def encode(self) -> str:
        """Encode chunk into the QRed seal format string."""
        return f"{self.format_id}|{self.document_id}|{self.chunk_number}|{self.total_chunks}|{self.data}"

    @classmethod
    def decode(cls, encoded: str) -> "QRedChunk":
        """Decode a QRed seal string back into a chunk."""
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
    document: Optional[DocumentPayload] = None
    error_message: str = ""
    issuer: str = ""
    document_id: str = ""
    timestamp: str = ""
    content: str = ""

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "issuer": self.issuer,
            "document_id": self.document_id,
            "timestamp": self.timestamp,
            "content": self.content,
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

    def to_dict(self) -> dict:
        return {
            "document_id": self.document_id,
            "bootstrap_url": self.bootstrap_url,
            "chunks": [c.encode() for c in self.chunks],
            "total_chunks": self.total_chunks,
            "payload_json": self.payload_json,
        }