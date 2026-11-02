# Compact v3 PDF scanner fixtures

Synthetic PDFs stamped by the current byte-mode browser implementation, saved, and
independently rasterized with Poppler at 300 dpi. These contain no private data.
The generated 300 dpi fixtures use timestamp `2026-10-20T17:55:14.123Z` for reproducibility.

Public demo/test key: `eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=`.
The fixture generator deliberately uses the repository's public test seed.

- `invoice-footer-300dpi.png`: invoice footer, including its 2.75-inch QR.
- `invoice-full-300dpi.png`: the same saved PDF's full first page.
- `inventory-footer-300dpi.png`: first inventory page’s footer.
- `inventory-four-inch-300dpi.png`: first page's signed multipage record,
  placed at four inches in a controlled PDF and rasterized.
- `manifest-seal-{1,2}-300dpi.png`: two QR crops from one saved PDF page.
- `invoice-damage.json`: pixel rectangle and opposite color for one module
  holding the high bit of the ordinary byte-mode header. Tests change it to verify
  recovery through Reed–Solomon correction rather than unchecked image bits.
- `delivery-part-{1,2}-200dpi.png`: 550-pixel QR crops from a synthetic two-page
  delivery PDF. The first page contains 45 delivery records in plaintext; the
  second says `Final delivery page. All items received.` Tests center these dense
  grids in a larger white image and verify both pieces and their signature.

To regenerate all fixtures, run from `frontend`:

```
node node_modules/vite-node/vite-node.mjs scripts/generateCompactFixtures.mjs
```

The older `../qr-scans` images and `../../qred_hidden_payload_photo.jpg` remain
only for rejection/retired-format regressions. Their padding payloads are not read.
