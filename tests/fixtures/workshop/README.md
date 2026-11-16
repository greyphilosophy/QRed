# Fictional workshop photo fixtures

The PDFs are drawn from blank US Letter pages. The document text, batch numbers, prices, stock tags and seals are generated from the workshop script and the repository's public demo key. The camera frames, desk and lighting are generated from the PDFs. The generator takes an output directory as its only input.

| Printable document | What to verify |
| --- | --- |
| `Workshop_Statement.pdf` | Page 1 has a small, pale signed seal near the bottom of a ruled table and a separate navigation QR. Page 2 has a full-page watermark and a signed inspection year of 2037. |
| `Workshop_Statement_Changed.pdf` | Page 2 prints 2032 with the same signed seal. The verifier should identify the signed 2037 and the photographed 2032 together. |
| `Workshop_Lot_Register.pdf` | Four quadrants carry four parts of a single signed page. Authentication requires recovering all four. |

The three PDFs and the six JPEGs in `photos/` are the fixed inputs used by the tests. A future change to the stamper cannot silently replace a previously signed page.

## Regenerate the print packet

From the repository root, with Node dependencies installed in `frontend/`, install Pillow and Poppler (`pdftoppm` and `pdftotext`) and run

```sh
python tests/fixtures/workshop/render.py /tmp/qred-workshop
```

The output includes the PDFs, the demo public verification key, three expected signed page records and six JPEGs. Each JPEG is 1920 × 2560. Both camera profiles put the whole sheet in view. The oblique profile adds 97% print scaling, a two-degree rotation, slight page curvature and stronger uneven lighting. For a physical check, print on US Letter at 100% and photograph the whole sheet.

## Run the acceptance tests

With the built production frontend served on port 3000 (or `QRED_BASE_URL`), run

```sh
pytest -v tests/test_workshop_photos.py
QRED_WORKSHOP_STRICT=1 pytest -v tests/test_workshop_photos.py
```

The first command is part of normal CI. It checks the one-digit edit in the PDFs and four offline browser uploads. Each upload must authenticate the intended page and recover the exact signed payloads pinned in `expected.json`. The unchanged inspection year must match. The changed page must show the signed year 2037 and photographed year 2032 together in the same difference.

The second command also requires seal recovery for the small pale seal on the front page and the oblique lot register. CI publishes those two additional cases in the workflow summary as advisory checks. Each case can also be run individually with pytest's `-k` option.
