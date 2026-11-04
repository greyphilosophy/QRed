import { expect, it } from "vitest";
import { alignmentCenters } from "./qrLowLevel.js";
import { refineQrModuleGrid } from "./qrAlignmentRefinement.js";

function shiftedPatterns(shift, version = 14) {
  const size = 17 + version * 4, pitch = 7, margin = 50;
  const width = size * pitch + margin * 2, height = width;
  const data = new Uint8ClampedArray(width * height * 4).fill(245);
  const centers = alignmentCenters(version);
  for (let ri = 0; ri < centers.length; ri++) for (let ci = 0; ci < centers.length; ci++) {
    if ((!ri && !ci) || (!ri && ci === centers.length - 1) || (ri === centers.length - 1 && !ci)) continue;
    for (let row = -2; row <= 2; row++) for (let col = -2; col <= 2; col++) {
      const dark = Math.abs(row) === 2 || Math.abs(col) === 2 || (!row && !col);
      if (!dark) continue;
      const x = margin + (centers[ci] + col) * pitch + shift;
      const y = margin + (centers[ri] + row) * pitch + shift;
      for (let dy = 0; dy < pitch; dy++) for (let dx = 0; dx < pitch; dx++) {
        const at = ((y + dy) * width + x + dx) * 4;
        data[at] = data[at + 1] = data[at + 2] = 205;
      }
    }
  }
  return { image: { data, width, height }, version, size,
    mapping: (u, v) => ({ x: margin + u * size * pitch, y: margin + v * size * pitch }) };
}

it("retains the wide search for alignment patterns outside the quick radius", () => {
  const { image, mapping, version, size } = shiftedPatterns(27);
  const region = { x: 0, y: 0, width: 1, height: 1 };
  const local = refineQrModuleGrid(image, mapping, region, version, { searchRadius: 12, foregroundRobust: true });
  const wide = refineQrModuleGrid(image, mapping, region, version, { foregroundRobust: true });
  const expected = mapping(0.5, 0.5);
  const error = grid => grid ? Math.hypot(grid.moduleMap(size / 2, size / 2).x - expected.x - 27,
    grid.moduleMap(size / 2, size / 2).y - expected.y - 27) : Infinity;
  expect(error(local)).toBeGreaterThan(10);
  expect(wide?.quality).toBeGreaterThan(0.9);
  // Exposed-pixel matching may settle anywhere inside the same 7px cell.
  expect(error(wide)).toBeLessThan(3.5);
});

it("stops between alignment markers when its scan budget expires", () => {
  const { image, mapping, version } = shiftedPatterns(0);
  let checks = 0;
  expect(refineQrModuleGrid(image, mapping, { x: 0, y: 0, width: 1, height: 1 }, version, {
    searchRadius: 12, shouldContinue: () => ++checks < 3,
  })).toBeNull();
  expect(checks).toBe(3);
});

it.each([7, 10, 13])("fits all six available alignment markers in QR version %s", version => {
  const { image, mapping } = shiftedPatterns(3, version);
  const grid = refineQrModuleGrid(image, mapping, { x: 0, y: 0, width: 1, height: 1 }, version,
    { searchRadius: 12, foregroundRobust: true });
  expect(grid?.quality).toBe(1);
});
