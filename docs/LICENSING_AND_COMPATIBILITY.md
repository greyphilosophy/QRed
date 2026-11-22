# Licensing and QR compatibility

Updated November 22, 2026, for the proposed noncommercial license transition.

## Source-code rights

QRed's reference implementation is offered under the
[PolyForm Noncommercial License 1.0.0](../LICENSE). This permits
noncommercial use, modification, and distribution, including the explicitly
permitted uses by certain nonprofit, educational, research, public-safety,
health, and government organizations. It does not grant permission for
other commercial uses. The source is publicly visible, but this is a
**source-available license, not an OSI-approved open-source license**.
Requests for separate commercial rights should go to the project maintainer.

**This is not retroactive.** Earlier QRed source code was offered under
[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).
Permissions already granted for those prior versions are not revoked by
this license change. Existing copies and forks may continue using those
earlier versions subject to their Apache terms. A new license on this
repository also does not supersede the rights of any other copyright holders.

Dependencies retain their own licenses and notices; QRed's project license
does not replace their terms. Keep applicable license, attribution, and
modification notices when redistributing. The
[dependency patch notes](../frontend/patches/README.md)
record local changes to jsQR and other patched components.

PolyForm Noncommercial contains a patent license only for claims the
licensor has authority to grant. Neither that license nor the earlier
Apache 2.0 contributor patent grants confer rights over unrelated
third-party patents, general trademark permission, or a warranty of
noninfringement. These source-code licenses are distinct from the
[terms for QRed's hosted website](https://qred.org/terms.html).

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
