export const SEALS_PER_SHEET = 6;
export const SEAL_SHEET_MARGIN = 54;
export const SEAL_SHEET_INSTRUCTIONS_HEIGHT = 150;
const PRINT_MARGIN = 18;

// Return ink bounds, without an extra white border inside each box. A single
// white gap serves both neighboring codes; page margins supply the outer quiet
// zones. Reserve four modules at the largest physical module size on the sheet.
export function planSealSheetLayout(width, height, moduleCounts) {
  const count = moduleCounts.length;
  if (count < 1 || count > SEALS_PER_SHEET) {
    throw new RangeError("A seal sheet must contain between one and six seals.");
  }
  if (moduleCounts.some(size => !Number.isInteger(size) || size < 21 || size > 177 || (size - 21) % 4)) {
    throw new RangeError("Each seal must have a valid QR module count.");
  }
  const rows = count === 2 ? 2 : Math.ceil(count / 2);
  const columnsByRow = count === 2 ? [1, 1] : Array.from({ length: rows }, (_, row) => Math.min(2, count - row * 2));
  function geometry(gap) {
    const margin = Math.max(SEAL_SHEET_MARGIN, gap);
    const top = height - SEAL_SHEET_INSTRUCTIONS_HEIGHT - gap;
    const bottom = Math.max(PRINT_MARGIN, gap);
    const rowHeight = (top - bottom - (rows - 1) * gap) / rows;
    const sizes = columnsByRow.map(columns => Math.min((width - 2 * margin - (columns - 1) * gap) / columns, rowHeight));
    const quiet = Math.max(...moduleCounts.map((modules, index) => 4 * sizes[count === 2 ? index : Math.floor(index / 2)] / modules));
    return { top, rowHeight, sizes, quiet };
  }
  // Enlarging the gap shrinks the codes, so their required quiet zone decreases.
  // Find the smallest gap that accommodates every actual QR version on the sheet.
  let low = 0, high = Math.min(width, height - SEAL_SHEET_INSTRUCTIONS_HEIGHT) / 2;
  for (let iteration = 0; iteration < 48; iteration++) {
    const middle = (low + high) / 2;
    if (geometry(middle).quiet > middle) low = middle;
    else high = middle;
  }
  const gap = high + .001; // Allow for the vector renderer's coordinate rounding.
  const { top, rowHeight, sizes } = geometry(gap);
  const boxes = [];
  columnsByRow.forEach((columns, row) => {
    const size = sizes[row];
    const rowWidth = columns * size + (columns - 1) * gap;
    const rowTop = top - row * (rowHeight + gap) - (rowHeight - size) / 2;
    for (let column = 0; column < columns; column++) {
      boxes.push({ x: (width - rowWidth) / 2 + column * (size + gap),
        y: rowTop - size, width: size, height: size });
    }
  });
  return boxes;
}
