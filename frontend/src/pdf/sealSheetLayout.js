export const SEALS_PER_SHEET = 6;
export const SEAL_SHEET_MARGIN = 54;

// Reserve the same compact instructions and footer on every sheet. QR boxes
// include their four-module quiet zones; labels sit outside those boxes.
export function planSealSheetLayout(width, height, count) {
  if (!Number.isInteger(count) || count < 1 || count > SEALS_PER_SHEET) {
    throw new RangeError("A seal sheet must contain between one and six seals.");
  }
  const margin = SEAL_SHEET_MARGIN, gap = 18, labelHeight = 12;
  const top = height - 162, bottom = 48;
  const rows = count === 2 ? 2 : Math.ceil(count / 2);
  const rowHeight = (top - bottom - (rows - 1) * gap) / rows;
  const columnsByRow = count === 2 ? [1, 1] : Array.from({ length: rows }, (_, row) => Math.min(2, count - row * 2));
  const boxes = [];
  columnsByRow.forEach((columns, row) => {
    const size = Math.min((width - 2 * margin - (columns - 1) * gap) / columns, rowHeight - labelHeight);
    const rowWidth = columns * size + (columns - 1) * gap;
    const rowTop = top - row * (rowHeight + gap) - (rowHeight - labelHeight - size) / 2;
    for (let column = 0; column < columns; column++) {
      boxes.push({ x: (width - rowWidth) / 2 + column * (size + gap),
        y: rowTop - labelHeight - size, width: size, height: size, labelY: rowTop - 8 });
    }
  });
  return boxes;
}
