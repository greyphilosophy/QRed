# Compact v3 PDF scanner fixtures

Synthetic PDFs stamped by the current browser implementation, saved, and
independently rasterized with Poppler at 300 dpi. These contain no private data.
The generated 300 dpi fixtures use timestamp `2026-10-20T17:55:14.123Z` for reproducibility.

Public demo/test key: `eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=`.
The fixture generator deliberately uses the repository's public test seed.

- `invoice-footer-300dpi.png`: invoice footer, including its 2.75-inch QR.
- `invoice-full-300dpi.png`: the same saved PDF's full first page.
- `inventory-four-inch-300dpi.png`: first page's signed multipage record,
  placed at four inches in a controlled PDF and rasterized.
- `manifest-seal-{1,2}-300dpi.png`: two QR crops from one saved PDF page.
- `invoice-damage.json`: pixel rectangle and opposite color for one module
  holding the high bit of the hidden length field. Tests change it to verify
  recovery through Reed–Solomon correction rather than unchecked image bits.
- `delivery-part-{1,2}-200dpi.png`: original 550-pixel QR crops from a synthetic
  two-page delivery PDF stamped in the browser with the same public test key.
  The first page contains 45 delivery records in plaintext; the second says
  `Final delivery page. All items received.` These preserve the original scan
  regression, including its timestamp. Centered in a 700-pixel white image,
  the old locator estimates 141 modules instead of the actual 137 (version 30).
  The scanner test verifies both reconstructed pieces and their signature.

To regenerate the 300 dpi fixtures, run from `frontend`:

```
node node_modules/vite-node/vite-node.mjs scripts/generateCompactFixtures.mjs
```

The older `../qr-scans` images remain as locator/rescaling regressions; their
retired signature format is intentionally rejected.
