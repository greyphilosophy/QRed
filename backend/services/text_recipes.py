"""Reversible text recipe helpers for QRed seal generation.

The b45 transform is provided by the external ``b45`` package so QRed uses the
same reference implementation as https://github.com/greyphilosophy/b45.
"""

from __future__ import annotations

import base64
from dataclasses import asdict, dataclass

import brotli
from b45 import decode as _b45_decode
from b45 import encode as _b45_encode

B45_RECIPE_ID = "b45"
B45_LONG_RECIPE_ID = "base45ish"
BROTLI_RECIPE_ID = "brotli"


@dataclass(frozen=True)
class RecipeDiagnostic:
    line: int
    reason: str
    original: str = ""
    restored: str = ""
    recommendation: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class RecipeValidationResult:
    recipe_id: str
    reversible: bool
    compact: str
    restored: str
    diagnostics: list[RecipeDiagnostic]

    def to_dict(self) -> dict:
        return {
            "recipe_id": self.recipe_id,
            "reversible": self.reversible,
            "compact": self.compact,
            "restored": self.restored,
            "diagnostics": [diag.to_dict() for diag in self.diagnostics],
        }


def encode_b45ish(text: str) -> str:
    return _b45_encode(text)


def decode_b45ish(compact: str) -> str:
    return _b45_decode(compact)


def encode_brotli(text: str) -> str:
    compressed = brotli.compress(text.encode("utf-8"), quality=11)
    return base64.urlsafe_b64encode(compressed).decode("ascii").rstrip("=")


def decode_brotli(compact: str) -> str:
    padded = compact + ("=" * ((4 - (len(compact) % 4)) % 4))
    compressed = base64.urlsafe_b64decode(padded.encode("ascii"))
    return brotli.decompress(compressed).decode("utf-8")


def validate_brotli(original: str) -> RecipeValidationResult:
    try:
        compact = encode_brotli(original)
        restored = decode_brotli(compact)
    except Exception as exc:
        return RecipeValidationResult(
            recipe_id=BROTLI_RECIPE_ID,
            reversible=False,
            compact="",
            restored="",
            diagnostics=[
                RecipeDiagnostic(
                    line=1,
                    reason=f"brotli round-trip failed: {exc}",
                    original=original,
                    recommendation="Use b45 or plaintext instead.",
                )
            ],
        )

    reversible = restored == original
    diagnostics: list[RecipeDiagnostic] = []
    if not reversible:
        diagnostics = [
            RecipeDiagnostic(
                line=1,
                reason="brotli round-trip did not restore the original text.",
                original=original,
                restored=restored,
                recommendation="Use b45 or plaintext instead.",
            )
        ]
    return RecipeValidationResult(
        recipe_id=BROTLI_RECIPE_ID,
        reversible=reversible,
        compact=compact,
        restored=restored,
        diagnostics=diagnostics,
    )


def validate_b45(original: str) -> RecipeValidationResult:
    compact = encode_b45ish(original)
    try:
        restored = decode_b45ish(compact)
    except Exception as exc:
        return RecipeValidationResult(
            recipe_id=B45_RECIPE_ID,
            reversible=False,
            compact=compact,
            restored="",
            diagnostics=[
                RecipeDiagnostic(
                    line=1,
                    reason=f"b45 decoding failed: {exc}",
                    original=original,
                    recommendation="Use plaintext or another reversible recipe instead.",
                )
            ],
        )

    reversible = restored == original
    diagnostics: list[RecipeDiagnostic] = []
    if not reversible:
        diagnostics = [
            RecipeDiagnostic(
                line=1,
                reason="b45 round-trip did not restore the original text.",
                original=original,
                restored=restored,
                recommendation="Use plaintext or another reversible recipe instead.",
            )
        ]
    return RecipeValidationResult(
        recipe_id=B45_RECIPE_ID,
        reversible=reversible,
        compact=compact,
        restored=restored,
        diagnostics=diagnostics,
    )


# Compatibility aliases kept so older call sites keep working while the recipe
# itself lives in the external b45 package.
def encode_simple_english(text: str) -> tuple[str, list[RecipeDiagnostic]]:
    compact = encode_b45ish(text)
    return compact, []


def decode_simple_english(compact: str) -> str:
    return decode_b45ish(compact)


def validate_simple_english(original: str) -> RecipeValidationResult:
    return validate_b45(original)
