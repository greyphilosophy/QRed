# Experimental erasure transport (QRE3 / QRE4)

This is an opt-in transport and layout prototype, not the default stamping mode.
It preserves the complete existing signed/compressed QRS3 or QRS4 envelope.
It does not make OCR ground truth, authenticate a photograph, or guarantee clean
text comparison. Old readers do not support QRE shards; their legacy QRS/QRC
formats remain unchanged and supported here.

## Wire format

All multibyte integers are unsigned big-endian. Header length: 48 bytes.

| Offset | Length | Field |
| --- | --- | --- |
| 0 | 4 | ASCII QRE3 or QRE4, matching inner QRS3/QRS4 |
| 4 | 1 | Transport version: 1 |
| 5 | 1 | Scheme: 1 |
| 6 | 1 | Required shards k |
| 7 | 1 | Available shards n |
| 8 | 1 | Zero-based shard index |
| 9 | 1 | Reserved: zero |
| 10 | 4 | Original envelope length L |
| 14 | 2 | Shard length s = ceil(L/k) |
| 16 | 32 | SHA-256 of exact original envelope |
| 48 | s | Coded shard bytes |

Require 2 <= k < n <= 16, index < n, L >= 86, s <= 2905 and exact
48+s byte payloads. These bounds are transport limits, not a claim that every
payload fits a desired physical QR version/ECC. Copy/paste representation stays
canonical QRED3:/QRED4: Base 64URL; raw QR byte segments carry the binary record.

Scheme 1 uses GF(256) with polynomial 0x 11d. Split the original envelope into k
consecutive blocks of s bytes, zero-padding the last block. Shard index i uses
evaluation point x=i+1 and coefficients 1,x,...,x^(k-1). Each output byte is the
field sum of the corresponding source-block bytes times these coefficients.
This is QRed's experimental wire scheme, not an RFC wire-compatibility claim.

Group by E1, envelope version, k, n, L and the complete digest. Version and scheme
are fixed by the parser; shard length is derived from L/k. The E identity cannot
collide with legacy S/C grouping. Identical duplicates do not increase recovery
count; conflicting duplicates fail. Any k **intact, distinct** shards reconstruct
the original. Sort indices and use the first k, with no subset search. Reject
nonzero padding, verify full digest, and deterministically re-encode/check every
received shard, including those used for reconstruction. Then decode the exact
QRS envelope and run the existing signature/evidence/authority verification.
Neither a parsed shard nor a matching digest constitutes authentication.

A corrupt extra received shard can make the set fail even when k other shards
are good. This is intentional fail-closed behavior. The minimal implementation
recovers erasures, not arbitrary malicious corruption.

Transport parameters are not separately signed. A holder of a valid signed
record can repackage it under different k/n without altering its signed content.
Do not describe those parameters as an issuer-approved redundancy policy.

## Bounds and opt-in use

- Reconstruction: at most 16 shards, at most 16x 16 matrix, at most 46,480 coded
  source bytes. No recursive or combinatorial recovery attempts.
- Verification entry points: at most 4,096 raw inputs,8,192 characters per input,
  and 24MiB aggregate characters; collection verification runs at most 4 groups
  concurrently, stops after cancellation between batches, and caps conservatively
  accounted retained decoded output at 64 MiB.
- `createQRedSeals({experimentalErasure:{required:12,total:16}, ...})` is explicit
  transport creation only. Normal callers keep their original 1–4 QR behavior.
  Existing PDF renderers are not automatically switched to the new layout.
- `planNonoverlapErasure` accepts only a 2x render up to 3MP. It reserves all
  nonwhite source pixels, including faint ink and antialiasing; source content
  is neither resized nor rewritten. It uses M ECC and at least 1.25pt modules,
  four-module quiet zones, 36pt default margins and 2pt source-ink guard.
- A plan can be unavailable because of capacity, geometry, or whitespace. The
  caller must retain its existing layout or ask for another layout. It must not
  shrink original content, remove evidence, weaken ECC or reduce modules to fit.
- An available geometry plan is not optical acceptance. A caller must render and
  preflight real shard recovery before use. Default UI stamping is unchanged.
- Discovery is pixel-only, with 3MP image, 64 candidate and 4MP aggregate crop
  bounds. Crop contrast is used only for QR decoding, never as an OCR transcript.
  Original document pixels remain the comparison input. This initial discovery
  targets upright modest-resolution pages, not arbitrary camera perspective.

## Verification evidence

Generated-only tests cover all 1,820 choices of 12 from 16 shards, a frozen wire
vector, offset byte views, corruption, extra parity, padding-only mutation,
malformed headers, duplicate/mixed inputs, and the normal signature path.
A generated PDF test preserves every original nonwhite pixel and verifies through
normal PDF scanning with four entire printed symbols absent. Existing fixtures
and normal-layout tests remain required. Physical printing/camera and broad
real-document layout acceptance are not established by these tests.
