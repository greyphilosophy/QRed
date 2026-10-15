# Rendered PDF scanner regressions

These synthetic documents were stamped through the public QRed UI on
2026-10-14, then downloaded and rasterized independently with MuPDF at 300 dpi.
They contain no real customer data. The disposable signing key is not included.

Public key: `Sz8MZnNyHPkt6J3hC_rcXEabv4rrQSgAH_krcitjlF8`

- `invoice-footer-300dpi.png`: the downloaded invoice's full footer.
- `invoice-full-300dpi.png`: the same invoice as a full-page image.
- `inventory-footer-300dpi.png`: the first page of a two-page inventory.
- `inventory-four-inch-300dpi.png`: that exact embedded QR image placed at four
  inches square in a controlled PDF render. Increasing size alone did not fix it.
- `manifest-seal-{1,2}-300dpi.png`: separate crops of a two-seal manifest page.

Unmodified jsQR fails to locate the codes in all of these except manifest seal 1.
Tests must recover the hidden payload from these pixels and verify its signature;
detecting just the public `QRED.ORG` marker is insufficient.
