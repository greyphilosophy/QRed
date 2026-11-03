# OCR comparison after PR 171

PR 171 is merged at `13684c5bf1df140e5204a9024d5e0965fff9ce38`. This rerun uses the exact same eight camera images on the original experiment frontend and on that frontend merged with PR 171. Image hashes are checked before comparison.

**Result: useful OCR and review improvements, but 0 of 8 images reached a clean automatic match.** This is an isolated OCR benchmark; fixture seals supply authenticated reference text and layout even for unsealed controls. It does not assert that a seal was recovered from each photo. The original 10/18 hex optical result was not rerun or changed by this comparison.

The harness now passes the authenticated text, page evidence, and retained image into `reader.read`, and passes the evidence into `comparePageReading`. Without that update it would miss PR 171's new retry path. Expected words are not supplied to Tesseract recognition.

| Existing camera image | Content groups before | After | Spacing reviews after | Line-based comparison after |
| --- | ---: | ---: | ---: | --- |
| plain-source-only-reference-168.jpg | 3 | 2 | 1 | Yes |
| dense-source-only-reference-168.jpg | 24 | 33 | 2 | Yes |
| plain-rect-reference-168.jpg | 5 | 4 | 1 | Yes |
| dense-rect-reference-168.jpg | 36 | 45 | 3 | Yes |
| plain-hex12-reference-168.jpg | 5 | 5 | 0 | No |
| dense-hex12-reference-168.jpg | 31 | 30 | 1 | No |
| plain-production-reference-911.jpg | 4 | 3 | 1 | Yes |
| dense-production-reference-911.jpg | 33 | 48 | 2 | Yes |

All eight still return `differences`. Counts are comparison groups, not character error rates. Line-based comparison can split one earlier group into several, so a larger count does not by itself establish worse recognition.

The retained readings show specific improvements:

- On the unwatermarked dense invoice, a reread recovered `Charge Credit` after the original `Date Description` heading.
- On the actual production dense invoice, a reread corrected `Bahnce -100.00` to `Balance -100.00`.
- Joined words such as `Account123456` are now classified as spacing reviews.
- Conflicting first and closer readings remain reviewable. Both hex images fall back to sequence comparison; neither activates line-based comparison in this run.

All 81 targeted OCR, retry, layout, comparison, reading and page-check tests passed. The PR 171 head also has successful GitHub checks (16 CI jobs plus its Workers build). This does not replace a full print/camera acceptance test.

## Reproduce

Use separate frontend checkouts before and after PR 171, with their normal dependencies and OCR/PDF assets prepared. Keep the camera images and manifest from the original hex experiment:

```sh
.venv/bin/python experiments/hex_spokes/compare_ocr_versions.py \
  --baseline-frontend /path/to/pre171/frontend \
  --candidate-frontend /path/to/with171/frontend \
  --photos-root /path/to/original/simulation-results/hex \
  --output simulation-results/hex/ocr171
```

Pass `--chromium /path/to/chromium` if needed. The old reader safely ignores the additional reference argument; the new reader uses it. Full old/new readings, accepted retries, image hashes, and frontend commits are in [ocr-pr171-evidence.json](ocr-pr171-evidence.json).
