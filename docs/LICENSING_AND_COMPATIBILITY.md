# Licensing and QR compatibility

Updated November 1, 2026, after the merge of
[PR #163](https://github.com/greyphilosophy/QRed/pull/163).

## Source-code rights

QRed's reference implementation is licensed under [Apache License 2.0](../LICENSE).
Dependencies retain their own licenses and notices; QRed's license does not
replace those terms. Keep applicable license, attribution and modification
notices when redistributing. The [dependency patch notes](../frontend/patches/README.md)
record local changes to jsQR and other patched components.

Apache 2.0 includes a contributor patent grant for covered claims that the
contributor can license. It does not license unrelated third-party patents,
provide general trademark permission, or warrant noninfringement. See the
[license text, especially sections 3, 4, 6 and 7](https://www.apache.org/licenses/LICENSE-2.0).

## Message encoding and printed geometry

| Component | Current behavior | Compatibility boundary |
| --- | --- | --- |
| Payload message | A v3/v4 binary record or chunk in one ordinary QR byte segment, with normal terminator and padding | A standard decoder can return the message bytes; QRed interprets and verifies them. A camera app need not display binary contents usefully. |
| Footer seals | Square Model 2 QR matrices with four-module quiet zones | Intended for conventional QR decoding; actual print size, contrast and camera conditions still matter. |
| Full-page watermarks | Model 2 matrices stretched independently in X and Y, with pale rectangular cells and quiet zones reconstructed during scanning | Experimental geometry for QRed's scanner; not represented as JIS/ISO-conformant printed symbols or rMQR codes. |
| Navigation overlay | A separate URL QR with its own quiet zone, optionally over a watermark on page one | Accepted only after the navigation code and all signed chunks pass recovery checks. Recoverability does not establish patent permission. |

The padding migration changes the message carrier, not the watermark geometry.
No application data is now stored after the terminator, and the verifier does
not retain a hidden-padding recovery path. Retired padding-format images need
re-sealing; current v3/v4 copyable strings are unchanged. See
[the transport specification](COMPACT_SEALS_V3.md).

## Patent and conformance disclosures

[DENSO WAVE's public patent policy](https://www.qrcode.com/en/patent.html)
conditions free use on following JIS/ISO QR standards and directs users to
contact patent holders about deviations. QRed does not claim that this public
assurance covers its experimental rectangular watermark geometry, or that
separate permission has been obtained for those variations. Being outside that
assurance does not itself establish infringement of a particular patent.

QRed has undertaken a limited engineering comparison of selected patent claims
and its implementation. That work is not a comprehensive freedom-to-operate
opinion, an invalidity determination, or a guarantee of noninfringement.
The project's free availability and public source are not substitutes for
third-party rights. QRed is an experimental, publicly documented format, not a
standards-body approval or security certification.

## Keeping this record current

Revisit these disclosures when changing the payload carrier, finder detection,
angle-dependent code generation, border/ECC layout, overlays, signature versus
encryption behavior, or dependency licensing. Review actual granted claims and
the current implementation before making claims about permission or clearance.
Record code and deployment status separately; a merged change does not prove
that every deployed or saved offline copy has updated.
