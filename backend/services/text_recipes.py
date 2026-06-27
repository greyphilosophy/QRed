"""Reversible text recipe helpers for QRed seal generation.

The b45 recipe (Base45ish) is fully reversible and deterministic. It preserves
human-readable ASCII where possible, and uses short escapes for uppercase letters,
percent signs, plus signs, and UTF-8 byte escapes for everything else.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict

B45_RECIPE_ID = "b45"
B45_LONG_RECIPE_ID = "base45ish"
DIRECT_PUNCTUATION = {".", "-", "/", ":", "$", " "}
HEX_DIGITS = set("0123456789ABCDEF")


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


def _flush_utf8_bytes(buffer: bytearray, output: list[str]) -> None:
    if buffer:
        output.append(buffer.decode("utf-8"))
        buffer.clear()


def encode_b45ish(text: str) -> str:
    pieces: list[str] = []
    for char in text:
        if "a" <= char <= "z":
            pieces.append(char.upper())
        elif "A" <= char <= "Z":
            pieces.append(f"+{char}")
        elif char in {"%", "+"}:
            pieces.append(char * 2)
        elif char in DIRECT_PUNCTUATION or char.isdigit():
            pieces.append(char)
        else:
            for byte in char.encode("utf-8"):
                pieces.append(f"%{byte:02X}")
    return "".join(pieces)


def _decode_byte_escape(compact: str, index: int) -> tuple[int, int]:
    if index + 2 >= len(compact):
        raise ValueError("Truncated b45 byte escape")
    hex_pair = compact[index + 1 : index + 3]
    if hex_pair[0] not in HEX_DIGITS or hex_pair[1] not in HEX_DIGITS:
        raise ValueError(f"Invalid b45 byte escape: %{hex_pair}")
    return int(hex_pair, 16), index + 3


def decode_b45ish(compact: str) -> str:
    restored: list[str] = []
    utf8_bytes = bytearray()
    index = 0

    while index < len(compact):
        char = compact[index]
        if char == "+":
            _flush_utf8_bytes(utf8_bytes, restored)
            if index + 1 >= len(compact):
                raise ValueError("Truncated b45 uppercase escape")
            code = compact[index + 1]
            if not ("A" <= code <= "Z"):
                raise ValueError(f"Invalid b45 uppercase escape: +{code}")
            restored.append(code)
            index += 2
            continue

        if char == "%":
            if index + 1 >= len(compact):
                raise ValueError("Truncated b45 percent escape")
            if compact[index + 1] == "%":
                _flush_utf8_bytes(utf8_bytes, restored)
                restored.append("%")
                index += 2
                continue
            byte_value, index = _decode_byte_escape(compact, index)
            utf8_bytes.append(byte_value)
            continue

        _flush_utf8_bytes(utf8_bytes, restored)
        if "A" <= char <= "Z":
            restored.append(char.lower())
        elif char.isdigit() or char in DIRECT_PUNCTUATION:
            restored.append(char)
        else:
            raise ValueError(f"Invalid b45 character: {char}")
        index += 1

    _flush_utf8_bytes(utf8_bytes, restored)
    return "".join(restored)


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
                    recommendation="Use plaintext or legacy compression instead.",
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
                recommendation="Use plaintext or legacy compression instead.",
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
# itself moves to the b45 spec.
def encode_simple_english(text: str) -> tuple[str, list[RecipeDiagnostic]]:
    compact = encode_b45ish(text)
    return compact, []


def decode_simple_english(compact: str) -> str:
    return decode_b45ish(compact)


def validate_simple_english(original: str) -> RecipeValidationResult:
    return validate_b45(original)
