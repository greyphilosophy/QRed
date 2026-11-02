import { ENTRY_QR_SIZE } from "./navigationQr.js";
import { LEGAL_FOOTER_HEIGHT } from "./pageScaling.js";

export const QR_SIZE = 177;
const QR_GAP = 10;
const PANEL_MARGIN = 18;
const PANEL_PADDING = 10;
const PANEL_LABEL_HEIGHT = 18;

export function planQrStampLayout(pageWidth, qrCount, { reservedRightWidth = 0 } = {}) {
  const usableWidth = Math.max(QR_SIZE, pageWidth - (PANEL_MARGIN * 2) - (PANEL_PADDING * 2));
  const columns = Math.max(1, Math.floor((usableWidth + QR_GAP) / (QR_SIZE + QR_GAP)));
  const rows = Math.max(1, Math.ceil(qrCount / columns));
  const qrSize = reservedRightWidth
    ? Math.min(QR_SIZE, Math.floor((pageWidth - 2 * PANEL_MARGIN - reservedRightWidth - (columns - 1) * QR_GAP) / columns))
    : QR_SIZE;
  const panelWidth = reservedRightWidth ? pageWidth - 2 * PANEL_MARGIN : Math.min(
    pageWidth - (PANEL_MARGIN * 2),
    (PANEL_PADDING * 2) + (columns * QR_SIZE) + ((columns - 1) * QR_GAP),
  );
  const panelHeight = (PANEL_PADDING * 2) + PANEL_LABEL_HEIGHT + (rows * qrSize) + ((rows - 1) * QR_GAP);
  return { columns, rows, panelWidth, panelHeight, qrSize, gap: QR_GAP,
    ...(reservedRightWidth ? { qrOffsetX: 0 } : {}) };
}

export function planQrStampLayoutForFooterBand(pageWidth, qrCount, { footerBandHeight = LEGAL_FOOTER_HEIGHT, footerMargin = PANEL_MARGIN, minQrSize = 32, reservedRightWidth = 0 } = {}) {
  // QR PNGs already include their four-module quiet zone. Use the full extra
  // three inches, less a quarter-inch bottom print margin; place the caption
  // beside the grid instead of spending its height above the codes.
  const availableWidth = pageWidth - (PANEL_MARGIN * 2) - reservedRightWidth;
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

// Keep the first-page navigation code in the footer. Use an empty grid cell
// or the existing caption column before reserving a narrow separate column.
export function planFooterLayout(pageWidth, qrCount, { legal = false, navigation = false, captionWidth } = {}) {
  const footerMargin = legal ? 0 : PANEL_MARGIN;
  const gap = 12;
  let reservedRightWidth = 0;
  let layout = legal ? planQrStampLayoutForFooterBand(pageWidth, qrCount) : planQrStampLayout(pageWidth, qrCount);
  function grid() {
    const columns = Math.min(qrCount, layout.columns);
    return { x: footerMargin + (layout.qrOffsetX ?? PANEL_PADDING),
      y: footerMargin + (layout.qrOffsetY ?? PANEL_PADDING),
      width: columns * layout.qrSize + (columns - 1) * layout.gap,
      height: layout.rows * layout.qrSize + (layout.rows - 1) * layout.gap };
  }
  const spareCell = () => qrCount % layout.columns !== 0 && layout.qrSize >= ENTRY_QR_SIZE;
  let bounds = grid();
  if (navigation && !spareCell() && bounds.x + bounds.width + gap + ENTRY_QR_SIZE > pageWidth - PANEL_MARGIN) {
    reservedRightWidth = ENTRY_QR_SIZE + gap;
    layout = legal
      ? planQrStampLayoutForFooterBand(pageWidth, qrCount, { reservedRightWidth })
      : planQrStampLayout(pageWidth, qrCount, { reservedRightWidth });
    bounds = grid();
  }
  let captionAbove = !layout.labelBeside;
  if (layout.labelBeside && bounds.x + bounds.width + gap + captionWidth > pageWidth - PANEL_MARGIN) {
    // Leave a caption strip above a full-width grid, inside the same footer.
    layout = { ...planQrStampLayoutForFooterBand(pageWidth, qrCount,
      { footerBandHeight: LEGAL_FOOTER_HEIGHT - PANEL_LABEL_HEIGHT, reservedRightWidth }), panelHeight: LEGAL_FOOTER_HEIGHT };
    bounds = grid();
    captionAbove = true;
  }
  const caption = {
    x: captionAbove ? footerMargin + (layout.qrOffsetX ?? PANEL_PADDING) : bounds.x + bounds.width + gap,
    y: captionAbove ? footerMargin + layout.panelHeight - (layout.labelBeside ? 12 : PANEL_PADDING + 9)
      : bounds.y + bounds.height / 2,
  };
  let entry = null;
  if (navigation) {
    entry = spareCell()
      ? { x: bounds.x + (qrCount % layout.columns) * (layout.qrSize + layout.gap) + (layout.qrSize - ENTRY_QR_SIZE) / 2,
        y: bounds.y + (layout.qrSize - ENTRY_QR_SIZE) / 2 }
      : { x: bounds.x + bounds.width + gap,
        y: captionAbove ? bounds.y + (bounds.height - ENTRY_QR_SIZE) / 2 : caption.y - ENTRY_QR_SIZE - 8 };
    entry = { ...entry, width: ENTRY_QR_SIZE, height: ENTRY_QR_SIZE };
    if (entry.x < PANEL_MARGIN || entry.x + entry.width > pageWidth - PANEL_MARGIN ||
        entry.y < PANEL_MARGIN || entry.y + entry.height > footerMargin + layout.panelHeight) {
      throw new Error("This page is too small for a readable seal footer and navigation QR.");
    }
  }
  return { ...layout, footerMargin, footerHeight: footerMargin + layout.panelHeight, caption, entry };
}
