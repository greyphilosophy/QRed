# Page-aware watermark recovery (experimental)

QRed uses the same signed QR payload and QR Reed–Solomon checks for both
ordinary printed seals and pale watermarks. Do not accept the visible
`QRED.ORG` marker as proof; verification requires *all* corrected hidden
bytes and the valid signed page envelope.

## Decoder

1. The QR finder/alignment pass locates a candidate grid, including its
   module-to-image mapping. No trusted PDF metadata is required.
2. Local brightness normalization compensates for camera shadows.
3. Mask definite foreground *both* by darkness and color saturation.
   A brightly colored glyph must not become a gray QR bit merely because
   its average brightness matches pale watermark ink.
4. Within each mapped module, sample exposed pixels throughout the cell.
   Vote only on unambiguous gray watermark or paper; ignore foreground and
   indecisive gray values. Unrecoverable cells retain the conservative
   preprocessed estimate.
5. Run the existing QR decoder and Reed–Solomon checks on the reconstructed
   matrix. Only a complete hidden payload can validate the signature.

Still photos and PDF scans use this fallback after ordinary scans; live
camera frames now rotate through it as a bounded separate attempt.

## Placement and overflow

A PDF page may contain up to four signed QR chunks. The existing placement
planner considers one-, two- and 2x2 four-code layouts using the physical
module-size minimum and reserved finder zones. Every proposed watermark
must pass exact-payload rendered and simulated-photo preflight before sealing;
otherwise the page uses a footer **only if the footer's modules remain large
enough to photograph**. Dense 3–4-code pages that fail their watermark
preflight fail closed rather than silently produce miniature footer codes.

This version deliberately keeps the four-module printed quiet zones and
square QR cells: it does not yet rectify phone photographs from paper corners,
stretch rectangular QR grids, support erasure-aware QR decoding, or strip
physical quiet zones in the 2x2 layout. Those need separate printed-camera
validation before enabling; the photo must remain independently verifiable
without a saved layout.
