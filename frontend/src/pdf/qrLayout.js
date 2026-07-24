
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

function makeLayout(columns, rows, qrSize) {
  return {
    columns, rows,
    panelWidth: (PANEL_PADDING * 2) + (columns * qrSize) + ((columns - 1) * QR_GAP),
    panelHeight: (PANEL_PADDING * 2) + PANEL_LABEL_HEIGHT + (rows * qrSize) + ((rows - 1) * QR_GAP),
    qrSize, gap: QR_GAP,
  };
}

function layoutFitsFooterBand(pageWidth, footerBandHeight, footerMargin, layout) {
  return layout.panelWidth <= pageWidth - (PANEL_MARGIN * 2) && layout.panelHeight <= footerBandHeight - footerMargin;
}

function planQrStampLayoutForSize(pageWidth, qrCount, qrSize, { footerBandHeight = null, footerMargin = PANEL_MARGIN } = {}) {
  const usableWidth = Math.max(qrSize, pageWidth - (PANEL_MARGIN * 2) - (PANEL_PADDING * 2));
  const maxColumns = Math.max(1, qrCount);
  let bestLayout = null;
  for (let columns = 1; columns <= maxColumns; columns += 1) {
    const rows = Math.max(1, Math.ceil(qrCount / columns));
    const layout = makeLayout(columns, rows, qrSize);
    const widthFits = layout.panelWidth <= pageWidth - (PANEL_MARGIN * 2) && layout.panelWidth <= usableWidth + (PANEL_PADDING * 2);
    const heightFits = footerBandHeight == null || layout.panelHeight <= footerBandHeight - footerMargin;
    if (!widthFits || !heightFits) continue;
    if (!bestLayout || layout.qrSize > bestLayout.qrSize || (layout.qrSize === bestLayout.qrSize && layout.columns > bestLayout.columns)) {
      bestLayout = layout;
    }
  }
  return bestLayout;
}

export function planQrStampLayoutForFooterBand(pageWidth, qrCount, { footerBandHeight = 216, footerMargin = 1, minQrSize = 32 } = {}) {
  const maxAvailableHeight = footerBandHeight - footerMargin - (PANEL_PADDING * 2) - PANEL_LABEL_HEIGHT;
  if (maxAvailableHeight <= 0) {
    throw new Error("Selected QR seals do not fit within the bottom 3 inches of a legal-sized page");
  }

  const oneRowWidthLimit = Math.floor((pageWidth - (PANEL_MARGIN * 2) - (PANEL_PADDING * 2) - ((qrCount - 1) * QR_GAP)) / qrCount);
  const oneRowHeightLimit = Math.floor(maxAvailableHeight);
  const oneRowQrSize = Math.min(oneRowWidthLimit, oneRowHeightLimit);
  if (oneRowQrSize >= minQrSize) {
    const oneRowLayout = makeLayout(qrCount, 1, oneRowQrSize);
    if (layoutFitsFooterBand(pageWidth, footerBandHeight, footerMargin, oneRowLayout)) return oneRowLayout;
  }

  const maxColumns = Math.max(1, qrCount);
  let bestLayout = null;
  for (let columns = 2; columns <= maxColumns; columns += 1) {
    const rows = Math.max(1, Math.ceil(qrCount / columns));
    const widthLimit = Math.floor((pageWidth - (PANEL_MARGIN * 2) - (PANEL_PADDING * 2) - ((columns - 1) * QR_GAP)) / columns);
    const heightLimit = Math.floor((maxAvailableHeight - ((rows - 1) * QR_GAP)) / rows);
    const qrSize = Math.min(widthLimit, heightLimit);
    if (qrSize < minQrSize) continue;
    const layout = planQrStampLayoutForSize(pageWidth, qrCount, qrSize, { footerBandHeight, footerMargin });
    if (!layout) continue;
    if (!bestLayout || layout.qrSize > bestLayout.qrSize || (layout.qrSize === bestLayout.qrSize && layout.columns > bestLayout.columns)) {
      bestLayout = layout;
    }
  }

  if (!bestLayout) {
    throw new Error("Selected QR seals do not fit within the bottom 3 inches of a legal-sized page");
  }

  return bestLayout;
}
