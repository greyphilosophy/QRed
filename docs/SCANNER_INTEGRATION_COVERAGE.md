# Scanner integration coverage

An integration case must fail when the handoff it protects is disconnected.
An image that another recovery path can read does not establish that coverage.
Keep existing unit tests for bounded algorithms and scheduling, but also connect
real pixel readers, transport reconstruction, signature verification and the UI.

## Added handoff checks

| Handoff | Required evidence | Test |
| --- | --- | --- |
| Curved-page recovery → photo decoder → verification session | Straight recovery misses; the curved retry supplies the actual recovered seal; its signature verifies and the wrong key fails. Source pixels stay unchanged. | `frontend/src/qr/decodePhoto.integration.test.js` |
| Worker checkpoint → watchdog → collection → later photo | Stop a real worker after its first decoded chunk. The normal watchdog delivers that chunk; a photo containing only the complementary chunk completes authentication. Clearing removes the first chunk. | `tests/test_scan_recovery_integration.py` on both routes |
| Lost checkpoint → incomplete collection | Suppress that same real message as a negative control. A later photo alone must remain incomplete, with no authenticated result. | The lost-checkpoint variant of the same browser test |
| Native photo → saved XMP/ZIP → reopened file → seal and text comparison | Save a synthetic EXIF-rotated JPEG through the capture UI after a controlled worker stall. Reload offline and open only the downloaded ZIP. Preserve portrait coordinates and report the photographed changed date after authenticating the seal. | `tests/test_auto_capture.py::test_saved_rotated_native_photo_reopens_with_its_digit_difference` on both routes |

The curved fixture uses a stronger bow than the existing helper-level fixture:
the older example also succeeds through the straight reader. During development,
dropping the early curved result made the new integration test fail; restoring
the handoff made it pass. This is a connection check, not a timing benchmark.

Browser deadline tests control the page clock and worker continuation. They do
not invent decoded chunks, authentication results or OCR readings. The saved-file
test controls native camera input and stalls the first decode request; after
reload, the actual worker, file opening, signature checks and OCR all run.

## Existing coverage and remaining combinations

| Area | Existing evidence | Remaining useful case |
| --- | --- | --- |
| Capture, light and framing | Both-route native-still, same-lens zoom/light/reopen, failed capture and retake tests | A lens switch followed by cancellation while native capture is pending; late results must not attach to the replacement capture. |
| Page layout and collection | Real watermark workflows; seal-sheet collection followed by unmarked originals; PDF input with the default layout | One mixed document whose text page has a watermark and whose image page uses an appended seal sheet, scanned out of order. Check page association and final completeness together. |
| Optical recovery | Pixel-level bending, shadows, overprint and parity tests; whole-photo curved dispatch; conventional footer dispatch | Broader combinations of physical wrinkles, shadows, printing and blur. Synthetic coverage does not establish printer/phone success rates. |

## Review rule

For a changed handoff, record its real input, downstream consumer, expected
failure if disconnected, and which boundary is simulated. Use a deliberate
disconnection or a negative control to establish that the test depends on it.
Keep at least one wrong-key, incomplete-chunk or changed-text assertion wherever
the tested flow could otherwise mistake successful recovery for verification.

Report saved-photo recovery, full browser verification and physical capture
separately. The original-photo replay requirement in `SCANNER_ACCEPTANCE.md`
still applies before closing a reported photo failure. These public fixtures
contain only fictional content; private originals must stay outside GitHub.
