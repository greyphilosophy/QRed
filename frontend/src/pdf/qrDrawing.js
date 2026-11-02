import { BlendMode, rgb } from "pdf-lib";

export function drawQrSymbol(page, symbol, box, gray, multiply = false, pageAligned = false) {
  const count = symbol.modules.size;
  const unitX = box.width / (count + (pageAligned ? 0 : 8));
  const unitY = box.height / (count + (pageAligned ? 0 : 8));
  // The QR module grid is generated once and scaled separately in X and Y.
  // The original PDF page, including its actual text, is never stretched.
  const paths = [];
  for (let row = 0; row < count; row++) {
    let column = 0;
    while (column < count) {
      if (!symbol.modules.get(row, column)) { column++; continue; }
      const start = column;
      while (column < count && symbol.modules.get(row, column)) column++;
      const run = column - start;
      paths.push(`M${(start * unitX).toFixed(4)} ${(row * unitY).toFixed(4)}h${(run * unitX).toFixed(4)}v${unitY.toFixed(4)}h-${(run * unitX).toFixed(4)}z`);
    }
  }
  // Multiply leaves black text black, even over an opaque white PDF background.
  // One vector path per symbol keeps printed modules sharp at any resolution.
  page.drawSvgPath(paths.join(""), { x: box.x + (pageAligned ? 0 : 4 * unitX),
    y: box.y + box.height - (pageAligned ? 0 : 4 * unitY),
    scale: 1, color: rgb(gray, gray, gray), blendMode: multiply ? BlendMode.Multiply : BlendMode.Normal });
}

