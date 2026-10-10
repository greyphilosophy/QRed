# Signed seals v2

New seals keep the existing `QRED1?` carrier and hidden QR framing, but set
`v=2`. Deploy the updated stamper and both verifier routes together. Old
verifiers do not understand the new signature message.

## What is authenticated

Ed25519 signs the UTF-8 bytes of this compact JSON array, using JavaScript
`JSON.stringify` serialization (no extra spaces):

```text
["QRed signed document",version,algorithm,document_id,issuer,key_id,timestamp,content]
```

Every element is a string. `version` is `"2"`; `algorithm` is `"Ed25519"`;
`content` is the restored canonical text, before any transport recipe. The
domain prefix and fixed field order are part of the signed message. `key_id`
is the first 16 lowercase hex characters of SHA-256 of the 32 public-key bytes.
The stamper checks that its supplied private and public keys match.

QR recipes and chunk boundaries are transport details. All chunks must agree
on document ID, total count, version, algorithm, issuer, key ID, timestamp,
and recipe. Chunk indices must be integers in `[0,n)`, with `1 <= n <= 4096`.
Only chunk 0 carries the signature. Identical repeated scans are harmless;
conflicting duplicate chunks, inconsistent metadata, unknown formats, and
malformed indices are rejected. Missing chunks cannot produce `VALID`.
Plaintext chunks split on Unicode code points, not UTF-16 code units.

## Legacy seals

Version 1 signed only the restored content. Valid v1 signatures now return
`LEGACY`, `signature_valid: true`, and `metadata_authenticated: false`, with
an explicit warning. They never receive an unqualified `VALID` result. Their
issuer label is a claim, not authenticated metadata. Missing trusted keys
return `UNVERIFIED`; bad signatures return `INVALID`. Re-sealing readable
source documents creates v2 seals. Changing the version field of a v2 seal
does not turn it into a valid legacy signature.

## PDF extraction and scope

PDF.js extracts text, including supported content filter chains, fonts, and
embedded form objects. A parsing failure or any page without readable text
stops sealing the whole file with an actionable error. Blank and image-only
pages are not silently signed as empty documents. OCR is not automatically
performed; scanned pages need a reviewed text layer before sealing.

Predefined character maps, standard fonts, and decoder assets ship with the
app under `/pdfjs/<version>/`; `npm start` and `npm run build` prepare them
from the pinned PDF.js package. Used assets are cached for offline reuse.
If a required font or character map fails, sealing stops even when another
part of the page has readable text. `stopAtErrors` alone is insufficient:
PDF.js can substitute an error font, so we also inspect font dependencies
in each page's operator list before accepting its extracted text.

Before extraction, supported AcroForm fields are flattened into page content.
Both text extraction and stamping use that same serialized flattened copy.
Text fields and dropdowns retain their saved appearances and fonts; missing
appearances are generated when possible. Each text appearance is independently
extracted and checked against its stored value, so stale appearances cannot
silently seal an outdated amount. Checkboxes and radio groups retain their
visible appearances as graphics, outside the text signature's coverage.

XFA, signature fields, unsupported field types, password/rich-text fields,
hidden, orphaned, or overlapping widgets, mismatched values, and unsupported appearance
geometry stop sealing with instructions to export a checked text PDF.
The UI reports how many fields were flattened. Review values in the downloaded
copy. Already flattened PDFs remain supported. This preparation does not add
visual-overlay tampering detection or authenticate graphics, and does not
flatten arbitrary non-form annotations.

QRed seals text and associated metadata, not a PDF's images, handwriting,
layout, or every byte of the PDF. Recipients must compare the recovered text
with the visible document. A signature alone does not establish that the
paper matches it. Obtain the issuer key independently from a trusted source;
the built-in demo keypair is public test data and proves no real issuer
identity.

## Regression checks

The PDF regression uses `tests/fixtures/ascii85-text.pdf`, generated with
ReportLab defaults and invariant output. It stamps the PDF, rasterizes the
actual footer at 300 dpi with Poppler, recovers the hidden payload from the
QR image, verifies the signature, and asserts all three source text lines.
Other tests cover blank/image-only/mixed pages, embedded form text,
Latin/CJK pages requiring predefined CMaps, failed fonts, automatic form
flattening, unsupported/stale forms, and preservation of values in signed and
output text. A raster comparison also checks that text, dropdowns, checkboxes,
and radio buttons keep their appearance after flattening and stamping. Browser
tests block CMap downloads and reject stale field appearances to confirm
sealing fails, and verify a filled form's value after automatic flattening.
Tests additionally cover
metadata tampering, wrong keys, Unicode chunk boundaries, missing and
conflicting chunks, homepage verification, and the standalone camera route.
The camera test supplies a synthetic image frame to the shipped inline
module and uses the real QR decoder and verifier, not its verification hook.
Physical-camera quality and arbitrary damaged/low-resolution scans remain
outside these automated checks.

The UI offers only implemented encoding strategies (automatic, plaintext,
and b45); the old nonfunctional Brotli selection was removed. Existing Brotli
payloads still require browser Brotli decompression support to decode.

Use Node 24, `npm ci`, `npm test`, `npm run lint`, and `npm run build:pages`
from `frontend`. Unit tests that rasterize PDFs also require `pdftoppm` from
`poppler-utils`. CI runs the unit suite before the build and browser checks.
