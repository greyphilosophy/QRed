import { pageWatermarkRegions } from "../pageAlignedScan.js";

// A generated page, not a retained photograph. Grain grows in the darker
// part of the sheet, making a high-percentile paper estimate brighter than
// the exposed white modules. One global threshold then confuses them with
// pale ink elsewhere. The decoder receives only these camera-like pixels.
export function shadowedPrint(symbol, grain, { bow = 0, overprint = false, cornerBend = 0, panelSize = 0 } = {}) {
  const scale = overprint ? 2 : 1;
  const width = 1000 * scale, height = 1300 * scale, data = new Uint8ClampedArray(width * height * 4);
  const paper = { x: 50 * scale, y: 50 * scale, width: 900 * scale, height: 1165 * scale };
  const region = pageWatermarkRegions(1, undefined, { marginPoints: 54 })[0];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = (x - paper.x) / paper.width, py = (y - paper.y) / paper.height;
    const bend = cornerBend * Math.max(0, (px - .45) / .55) ** 2 * Math.max(0, (py - .45) / .55) ** 2;
    const u = px + bend, v = py - bow * (2 * px - 1) ** 2 + bend * .65;
    let value = 80;
    if (bow) value += 55 * Math.max(0, Math.cos(30 * y / height - 7 * x / width)) ** 10;
    if (u >= 0 && v >= 0 && u < 1 && v < 1) {
      const col = Math.floor((u - region.x) / region.width * symbol.modules.size);
      const row = Math.floor((v - region.y) / region.height * symbol.modules.size);
      const inside = col >= 0 && row >= 0 && col < symbol.modules.size && row < symbol.modules.size;
      const dark = inside && symbol.modules.get(row, col);
      const illumination = 240 * (1 - v * 0.45);
      const noise = ((Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663)) >>> 0) % 1000 / 999 * 2 - 1;
      value = illumination * (dark ? 0.87 - 0.12 * v : 1) + noise * (2 + grain * v);
      if (inside && row > 15 && row < 125 && row % 19 === 0 && col % 4 !== 0) value = 40;
      if (overprint && inside) {
        if (col >= 63 && col < 63 + panelSize && row >= 33 && row < 33 + panelSize)
          value = illumination * (col % 3 === 1 && row % 3 === 1 ? .2 : 1);
        const moduleY = (v - region.y) / region.height * symbol.modules.size;
        if (row > 14 && row < 125 && row % 12 === 4 && col % 7 < 4 && moduleY - row < .7) value = 45;
        // A light navigation panel covers part of the top-right finder.
        if (col >= symbol.modules.size - 7 && col <= symbol.modules.size - 2 && row >= 2 && row < 4)
          value = illumination;
      }
    }
    const at = (y * width + x) * 4;
    data[at] = bow ? value * 1.1 : value;
    data[at + 1] = value;
    data[at + 2] = bow ? value * .9 : value;
    data[at + 3] = 255;
  }
  return { data, width, height };
}
