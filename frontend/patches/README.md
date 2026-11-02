# jsQR optical recovery fixes

`jsqr+1.4.0.patch` retains three optical recovery fixes:

- Try adjacent valid grid dimensions when the finder-pattern estimate is off.
- Accept a module sampler for low-contrast watermarks obscured by printed text.
- Correct the version-23 alignment-pattern center from 74 to 78.

The standard `binaryData` result contains the complete error-corrected message.
QRed uses an ordinary byte segment and does not expose or inspect QR padding.
There is no `correctedData` extension or post-terminator payload recovery.

The dependency is pinned to 1.4.0. `npm ci` applies the patch through
`postinstall`; `npm start` and `npm run build` also apply it to cover cached
dependencies. Patch failures stop installation/builds. When updating jsQR,
review and regenerate the patch, then run the damaged-seal regressions in
`src/qr/bytePayloadRecovery.test.js`, watermark tests, and browser tests.

Upstream: <https://github.com/cozmo/jsQR> (Apache-2.0; its license is retained
in the installed package). Patch workflow: <https://github.com/ds300/patch-package>.

# Tesseract initialization failures

`tesseract.js+6.0.1.patch` rejects `createWorker()` and terminates its worker
when language loading or engine initialization fails. Upstream swallows that
failure after rejecting an internal job, leaving the caller's startup promise
pending. This matters when a user goes offline before language data is cached.
The browser regression `test_missing_ocr_language_resource_fails_and_retries`
returns a real 404 for the model and checks that the reader reports an error
and can subsequently load successfully. Recheck this behavior when upgrading
Tesseract; its Apache-2.0 license is included with the deployed OCR resources.
