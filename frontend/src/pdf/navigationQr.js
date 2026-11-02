import QRCode from "qrcode";

// Uppercase URL uses QR alphanumeric mode. The URL standard treats scheme
// and host case-insensitively; omitting the trailing slash allows V1/Q.
export const ENTRY_URL = "HTTPS://QRED.ORG";
export const ENTRY_QR_SIZE = 36;

// Enforce the compact layout instead of relying on the QR library's automatic
// choice (which can silently change if its segmentation defaults change).
export function createEntryQrSymbol() {
  return QRCode.create([{ data: ENTRY_URL, mode: "alphanumeric" }], {
    version: 1, errorCorrectionLevel: "Q",
  });
}
