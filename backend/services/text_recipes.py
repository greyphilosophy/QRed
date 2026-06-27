"""Reversible text recipe helpers for QRed seal generation.

Recipe 1 is intentionally conservative: it only accepts simple English text
made of supported words, approved acronyms, digits, whitespace, and common
punctuation. Supported words are encoded into compact two-character escape
sequences, and the recipe is only considered valid when the round-trip is exact.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
import re
from typing import Iterable

TOKEN_RE = re.compile(r"\s+|[A-Za-z]+|[0-9]+|\*|[^A-Za-z0-9\s]")

# 36 compact codes for the most common English words in our narrow subset.
WORD_TO_CODE: dict[str, str] = {
    "the": "a",
    "and": "b",
    "to": "c",
    "of": "d",
    "in": "e",
    "for": "f",
    "is": "g",
    "on": "h",
    "with": "i",
    "that": "j",
    "this": "k",
    "it": "l",
    "as": "m",
    "are": "n",
    "be": "o",
    "at": "p",
    "by": "q",
    "from": "r",
    "or": "s",
    "not": "t",
    "you": "u",
    "we": "v",
    "can": "w",
    "if": "x",
    "one": "y",
    "all": "z",
    "document": "0",
    "page": "1",
    "qr": "2",
    "code": "3",
    "text": "4",
    "plain": "5",
    "recipe": "6",
    "automatic": "7",
    "legacy": "8",
    "compression": "9",
    "simple": "A",
    "english": "B",
    "valid": "C",
    "reversible": "D",
    "encoding": "E",
    "strategy": "F",
    "readable": "G",
    "choose": "H",
    "smallest": "I",
    "content": "J",
    "seal": "K",
    "verify": "L",
    "select": "M",
    "word": "N",
    "line": "O",
    "sentence": "P",
    "support": "Q",
    "rejected": "R",
}

CODE_TO_WORD = {code: word for word, code in WORD_TO_CODE.items()}
APPROVED_ACRONYMS = {
    "API",
    "HTTP",
    "HTTPS",
    "ID",
    "JSON",
    "NASA",
    "PDF",
    "PNG",
    "QR",
    "QRED",
    "SHA",
    "URL",
    "XML",
}


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


def _line_number(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def _describe_word_failure(token: str) -> str:
    if token.isupper():
        return "Unknown acronym."
    if token.islower() or token.istitle():
        return "Unsupported word for Recipe 1."
    return "Unsupported mixed-case word."


def _encode_word(token: str) -> tuple[str | None, RecipeDiagnostic | None]:
    lower = token.lower()
    if lower in WORD_TO_CODE:
        code = WORD_TO_CODE[lower]
        if token.islower():
            return f"*{code}", None
        if token.istitle():
            return f"^{code}", None
        if token.isupper():
            return f"!{code}", None
        return None, RecipeDiagnostic(
            line=1,
            reason="Unsupported mixed-case word.",
            original=token,
            recommendation="Rewrite the word in plain lowercase, title case, or approved acronym form.",
        )

    if token.isupper() and token in APPROVED_ACRONYMS:
        return token, None

    return None, RecipeDiagnostic(
        line=1,
        reason=_describe_word_failure(token),
        original=token,
        recommendation=(
            "Add this word to the recipe dictionary, rewrite it as a supported common word, "
            "or choose plaintext/legacy compression."
        ),
    )


def encode_simple_english(text: str) -> tuple[str, list[RecipeDiagnostic]]:
    diagnostics: list[RecipeDiagnostic] = []
    pieces: list[str] = []

    for match in TOKEN_RE.finditer(text):
        token = match.group(0)
        line = _line_number(text, match.start())

        if token == "*":
            diagnostics.append(
                RecipeDiagnostic(
                    line=line,
                    reason="Literal '*' is not allowed in Recipe 1.",
                    original=token,
                    recommendation="Replace '*' with a spelled-out word or use plaintext.",
                )
            )
            continue

        if token.isspace():
            pieces.append(token)
            continue

        if token.isdigit() or re.fullmatch(r"[.,!?;:\-()\[\]{}'\"/\\]", token):
            pieces.append(token)
            continue

        if token.isalpha():
            encoded, diagnostic = _encode_word(token)
            if encoded is None:
                assert diagnostic is not None
                diagnostics.append(
                    RecipeDiagnostic(
                        line=line,
                        reason=diagnostic.reason,
                        original=diagnostic.original,
                        recommendation=diagnostic.recommendation,
                    )
                )
            else:
                pieces.append(encoded)
            continue

        diagnostics.append(
            RecipeDiagnostic(
                line=line,
                reason="Unsupported character sequence for Recipe 1.",
                original=token,
                recommendation="Use only supported English words, digits, spaces, and simple punctuation.",
            )
        )

    compact = "".join(pieces)
    restored = decode_simple_english(compact) if not diagnostics else ""
    return compact, diagnostics


def decode_simple_english(compact: str) -> str:
    restored: list[str] = []
    index = 0
    while index < len(compact):
        char = compact[index]
        if char in {"*", "^", "!"}:
            if index + 1 >= len(compact):
                raise ValueError("Truncated Recipe 1 token")
            code = compact[index + 1]
            word = CODE_TO_WORD.get(code)
            if not word:
                raise ValueError(f"Unknown Recipe 1 code: {code}")
            if char == "*":
                restored.append(word)
            elif char == "^":
                restored.append(word.capitalize())
            else:
                restored.append(word.upper())
            index += 2
            continue
        restored.append(char)
        index += 1
    return "".join(restored)


def validate_simple_english(original: str) -> RecipeValidationResult:
    compact, diagnostics = encode_simple_english(original)
    if diagnostics:
        return RecipeValidationResult(
            recipe_id="recipe1",
            reversible=False,
            compact=compact,
            restored="",
            diagnostics=diagnostics,
        )

    try:
        restored = decode_simple_english(compact)
    except Exception as exc:
        return RecipeValidationResult(
            recipe_id="recipe1",
            reversible=False,
            compact=compact,
            restored="",
            diagnostics=[
                RecipeDiagnostic(
                    line=1,
                    reason=f"Recipe 1 decoding failed: {exc}",
                    original=original,
                    recommendation="Use plaintext or legacy compression instead.",
                )
            ],
        )

    reversible = restored == original
    diagnostics_out: list[RecipeDiagnostic] = [] if reversible else [
        RecipeDiagnostic(
            line=1,
            reason="Recipe 1 round-trip did not restore the original text.",
            original=original,
            restored=restored,
            recommendation="Rewrite the document using supported simple-English patterns or use plaintext.",
        )
    ]
    return RecipeValidationResult(
        recipe_id="recipe1",
        reversible=reversible,
        compact=compact,
        restored=restored,
        diagnostics=diagnostics_out,
    )
