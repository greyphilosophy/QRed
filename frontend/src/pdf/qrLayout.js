
export const QR_SIZE = 177;
const QR_GAP = 10;
const PANEL_MARGIN = 18;
const PANEL_PADDING = 10;
const PANEL_LABEL_HEIGHT = 18;

export function planQrStampLayout(pageWidth, qrCount) {
  const usableWidth = Math.max(QR_SIZE, pageWidth - (PANEL_MARGIN * 2) - (PANEL_PADDING * 2));
  const columns = Math.max(1, Math.floor((usableWidth + QR_GAP) / (QR_SIZE + QR_GAP)));
  const rows = Math.max(1, Math.ceil(qrCount / columns));
  const panelWidth = Math.min(
    pageWidth - (PANEL_MARGIN * 2),
    (PANEL_PADDING * 2) + (columns * QR_SIZE) + ((columns - 1) * QR_GAP),
  );
  const panelHeight = (PANEL_PADDING * 2) + PANEL_LABEL_HEIGHT + (rows * QR_SIZE) + ((rows - 1) * QR_GAP);
  return { columns, rows, panelWidth, panelHeight, qrSize: QR_SIZE, gap: QR_GAP };
}

export function planQrStampLayoutForFooterBand(pageWidth, qrCount, { footerBandHeight = 216, footerMargin = PANEL_MARGIN, minQrSize = 32 } = {}) {
  // QR PNGs already include their four-module quiet zone. Use the full extra
  // three inches, less a quarter-inch bottom print margin; place the caption
  // beside the grid instead of spending its height above the codes.
  const availableWidth = pageWidth - (PANEL_MARGIN * 2);
  const availableHeight = footerBandHeight - footerMargin;
  let bestLayout = null;
  for (let columns = 1; columns <= Math.max(1, qrCount); columns += 1) {
    const rows = Math.max(1, Math.ceil(qrCount / columns));
    const qrSize = Math.floor(Math.min(
      (availableWidth - ((columns - 1) * QR_GAP)) / columns,
      (availableHeight - ((rows - 1) * QR_GAP)) / rows,
    ));
    if (qrSize < minQrSize) continue;
    if (!bestLayout || qrSize > bestLayout.qrSize || (qrSize === bestLayout.qrSize && columns > bestLayout.columns)) {
      bestLayout = {
        columns, rows, qrSize, gap: QR_GAP,
        panelWidth: pageWidth, panelHeight: footerBandHeight,
        qrOffsetX: PANEL_MARGIN, qrOffsetY: footerMargin,
        gridWidth: (columns * qrSize) + ((columns - 1) * QR_GAP),
        gridHeight: (rows * qrSize) + ((rows - 1) * QR_GAP),
        labelBeside: true,
      };
    }
  }

  if (!bestLayout) {
    throw new Error("Selected QR seals do not fit within the bottom 3 inches of a legal-sized page");
  }

  return bestLayout;
}
