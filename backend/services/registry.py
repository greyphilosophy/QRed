"""Issuer Registry — trusted public key discovery for QRed verification.

The issuer registry provides the bridge between (issuer_id, key_id) and the
actual Ed25519 public key used for signature verification.

Trust model:
  - An issuer registers their public key in the registry.
  - Each key is identified by (issuer_id, key_id).
  - The key_id is derived from the public key bytes (SHA-256 hex[:16]).
  - The verifier looks up the public key using (issuer_id, key_id).
  - The sealer embeds (issuer_id, key_id) in the payload (not the public key).

The reference implementation uses an in-memory dictionary. Production
implementations might use a database, JSON file, or REST API.
"""

import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class RegisteredKey:
    """A registered public key in the issuer registry."""
    issuer_id: str
    key_id: str
    public_key: str
    algorithm: str = "Ed25519"
    registered_at: float = field(default_factory=time.time)
    expires_at: Optional[float] = None
    metadata: dict = field(default_factory=dict)


class IssuerRegistry:
    """In-memory issuer key registry for QRed."""

    def __init__(self):
        self._keys: dict[tuple[str, str], RegisteredKey] = {}
        self._by_issuer: dict[str, list[str]] = {}

    def register(
        self,
        issuer_id: str,
        key_id: str,
        public_key: str,
        algorithm: str = "Ed25519",
        expires_at: Optional[float] = None,
        metadata: Optional[dict] = None,
    ) -> RegisteredKey:
        """Register a public key for an issuer."""
        key = RegisteredKey(
            issuer_id=issuer_id,
            key_id=key_id,
            public_key=public_key,
            algorithm=algorithm,
            registered_at=time.time(),
            expires_at=expires_at,
            metadata=metadata or {},
        )
        self._keys[(issuer_id, key_id)] = key
        self._by_issuer.setdefault(issuer_id, []).append(key_id)
        return key

    def lookup(self, issuer_id: str, key_id: str) -> Optional[str]:
        """Look up a public key by (issuer_id, key_id)."""
        entry = self._keys.get((issuer_id, key_id))
        if entry is None:
            return None
        if entry.expires_at and time.time() > entry.expires_at:
            return None
        return entry.public_key

    def is_registered(self, issuer_id: str, key_id: str) -> bool:
        """Check if a key is registered and not expired."""
        return self.lookup(issuer_id, key_id) is not None

    def get_issuer_keys(self, issuer_id: str) -> list[str]:
        """Get all registered key_ids for an issuer."""
        return self._by_issuer.get(issuer_id, [])

    def remove(self, issuer_id: str, key_id: str) -> bool:
        """Remove a key from the registry."""
        entry = self._keys.pop((issuer_id, key_id), None)
        if entry:
            self._by_issuer.get(issuer_id, []).remove(key_id)
        return entry is not None

    def list_all(self) -> list[RegisteredKey]:
        """List all registered keys."""
        return list(self._keys.values())

    def count(self) -> int:
        """Return total number of registered keys."""
        return len(self._keys)


# Module-level registry instance (for the reference implementation)
registry = IssuerRegistry()
