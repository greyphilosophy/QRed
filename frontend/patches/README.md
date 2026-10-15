# jsQR corrected data stream

`jsqr+1.4.0.patch` exposes `correctedData` on successful jsQR results. This is
the complete data-codeword stream after jsQR's existing Reed-Solomon decoder
has corrected every block. `data`, `binaryData`, chunks, and geometry retain
their upstream meanings. No detection or error-correction algorithm changes.

QRed stores its signed payload after the visible `QRED.ORG` segment's
terminator. Upstream `binaryData` contains decoded message bytes only, so it
omits that padding. Previously QRed resampled the image without error
correction to recover it. The verifier and photo analyzer now read
`correctedData` first, including for inverted and mirrored codes. A malformed
corrected payload does not fall back to uncorrected pixels. Image sampling is
retained only for older scan results that lack the added field.

The dependency is pinned to 1.4.0. `npm ci` applies the patch through
`postinstall`; `npm start` and `npm run build` also apply it to cover cached
dependencies. Patch failures stop installation/builds. When updating jsQR,
review and regenerate the patch, then run the damaged-seal regressions in
`src/qr/hiddenPayloadRecovery.test.js` and the browser tests.

Upstream: <https://github.com/cozmo/jsQR> (Apache-2.0; its license is retained
in the installed package). Patch workflow: <https://github.com/ds300/patch-package>.
