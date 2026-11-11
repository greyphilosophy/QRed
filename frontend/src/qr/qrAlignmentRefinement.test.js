import { expect, it, vi } from "vitest";
import { alignmentCenters } from "./qrLowLevel.js";
import { refineQrModuleGrid } from "./qrAlignmentRefinement.js";

function shiftedPatterns(shift, version = 14, pitch = 7) {
  const size = 17 + version * 4, margin = 50;
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

it("can retain the independently measured finder corners when alignment extrapolation drifts", () => {
  const { image, mapping, version, size } = shiftedPatterns(8);
  const grid = refineQrModuleGrid(image, mapping, { x: 0, y: 0, width: 1, height: 1 }, version,
    { searchRadius: 12, foregroundRobust: true, measuredFinders: true });
  const markers = alignmentCenters(version).map(c => c + .5);
  const near = markers[0], far = markers.at(-1);
  for (const [col, row] of [[near, near], [far, near], [near, far]]) {
    const finder = mapping(col / size, row / size);
    const anchored = grid.finderModuleMap(col, row), inferred = grid.moduleMap(col, row);
    expect(Math.hypot(inferred.x - finder.x, inferred.y - finder.y)).toBeGreaterThan(3.5);
    expect(Math.hypot(anchored.x - finder.x, anchored.y - finder.y)).toBeLessThan(1e-8);
  }
  expect(grid.finderModuleMap(far, far)).toEqual(grid.moduleMap(far, far));
});

it.each([7, 10, 13])("fits all six available alignment markers in QR version %s", version => {
  const { image, mapping } = shiftedPatterns(3, version);
  const grid = refineQrModuleGrid(image, mapping, { x: 0, y: 0, width: 1, height: 1 }, version,
    { searchRadius: 12, foregroundRobust: true });
  expect(grid?.quality).toBe(1);
});

it.each([
  [true, [
    { x: 76.31306404309245, y: 585.8216292882813 },
    { x: 332.15, y: 330.95 },
    { x: 587.6205297069075, y: 75.35063633671865 },
  ]],
  [false, [
    { x: 75.34335523575713, y: 586.8203222318449 },
    { x: 331.65000000000003, y: 331.2 },
    { x: 586.7066447642428, y: 75.70467776815511 },
  ]],
])("preserves direct-pixel grid coordinates with fractional, tinted evidence (%s)", (foregroundRobust, expected) => {
  const { image, mapping, version, size } = shiftedPatterns(27);
  image.paperColor = [0.96, 1, 1.04];
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] -= i % 17;
    image.data[i + 1] -= 5;
    image.data[i + 2] -= 11;
  }
  const original = image.data.slice();
  const distorted = (u, v) => {
    const p = mapping(u, v);
    return { x: p.x + 0.15 + (v - 0.5) * 2, y: p.y - 0.3 + (u - 0.5) * 1.7 };
  };
  const grid = refineQrModuleGrid(image, distorted, { x: 0, y: 0, width: 1, height: 1 }, version,
    { foregroundRobust });
  expect(grid?.quality).toBe(1);
  // Captured from the original direct-pixel implementation. Cached luminance
  // must retain exact thirds and sample rounding, not alter the fit or ties.
  expect([0, size / 2, size].map(p => grid.moduleMap(p, size - p))).toEqual(expected);
  expect(image.data.every((value, i) => value === original[i])).toBe(true);
});

it("reads a bounded neighborhood instead of rereading source pixels for every shift", () => {
  const { image, mapping, version } = shiftedPatterns(27, 7);
  const data = image.data;
  let sourceReads = 0;
  Object.defineProperty(image, "data", { get() { sourceReads++; return data; } });
  const region = { x: 0, y: 0, width: 1, height: 1 };
  expect(refineQrModuleGrid(image, mapping, region, version, { foregroundRobust: true })?.quality).toBe(1);
  // Six search neighborhoods fit below 300,000 channel reads. Reading every
  // shift directly takes over four million; no machine-speed assertion needed.
  expect(sourceReads).toBeLessThan(300_000);
  data.fill(245);
  // Nothing is cached across calls, so changing an image cannot reuse pixels.
  expect(refineQrModuleGrid(image, mapping, region, version, { foregroundRobust: true })).toBeNull();
});

it("bounds neighborhood storage for unusually large module pitches", () => {
  const { image, mapping, version } = shiftedPatterns(3, 7, 64);
  const NativeFloat64Array = globalThis.Float64Array, allocations = [];
  vi.stubGlobal("Float64Array", class extends NativeFloat64Array {
    constructor(length) { super(length); allocations.push(length); }
  });
  try {
    const grid = refineQrModuleGrid(image, mapping, { x: 0, y: 0, width: 1, height: 1 }, version,
      { searchRadius: 12, foregroundRobust: true });
    expect(grid?.quality).toBe(1);
    expect(Math.max(...allocations)).toBeLessThanOrEqual(65_536);
  } finally { vi.unstubAllGlobals(); }
});
