import { expect, it } from "vitest";
import { encodedVersion } from "./qrLowLevel.js";
import { readRectifiedQrVersion } from "./rectifiedQrVersion.js";

const finderDark = (row, col) => row === 0 || col === 0 || row === 6 || col === 6 ||
  (row >= 2 && row <= 4 && col >= 2 && col <= 4);

// Generated public QR structure only. No photographed document or payload is
// needed to exercise exposure, missing fields, or the BCH correction limit.
function printedVersion(version, {
  ink = 210, paper = 245, finders = false, field = "both", word = encodedVersion(version),
  fieldValue = null, shadow = false, accuratePitch = false,
  finderInk = null, finderPaper = null, unavailableFinder = null, shear = 0.012,
} = {}) {
  const side = 900, size = 17 + 4 * version, pitch = side * 0.92 / size;
  const gray = new Uint8Array(side * side).fill(paper);
  const map = (col, row) => ({ x: 30 + pitch * (col + shear * row), y: 32 + pitch * (row + shear * col) });
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const u = (x - 30) / pitch, v = (y - 32) / pitch;
    const col = Math.floor((u - shear * v) / (1 - shear * shear));
    const row = Math.floor((v - shear * u) / (1 - shear * shear));
    const localPaper = shadow && row > size / 2 ? 229 : paper;
    const localInk = shadow && row > size / 2 ? 173 : ink;
    gray[y * side + x] = localPaper;
    let bit = -1;
    if (field !== "bottomLeft" && row >= 0 && row < 6 && col >= size - 11 && col < size - 8)
      bit = row * 3 + col - size + 11;
    if (field !== "topRight" && col >= 0 && col < 6 && row >= size - 11 && row < size - 8)
      bit = col * 3 + row - size + 11;
    if (bit >= 0) gray[y * side + x] = fieldValue ?? (word >> bit & 1 ? localInk : localPaper);
    if (finders) {
      const finderCol = col >= size - 7 ? col - size + 7 : col;
      const finderRow = row >= size - 7 ? row - size + 7 : row;
      if (finderCol >= 0 && finderCol < 7 && finderRow >= 0 && finderRow < 7 && (col < 7 || row < 7)) {
        const index = col >= size - 7 ? 1 : row >= size - 7 ? 2 : 0;
        gray[y * side + x] = unavailableFinder === index ? localPaper : finderDark(finderRow, finderCol)
          ? finderInk ?? localInk : finderPaper ?? localPaper;
      }
    }
  }
  const corners = [map(3.5, 3.5), map(size - 3.5, 3.5), map(3.5, size - 3.5)]
    .map((point, i) => ({ ...point, pitch: pitch * (accuratePitch ? 1 : [1.07, 0.96, 1.04][i]) }));
  return { gray, side, corners, map, size };
}

it.each([17, 27, 31, 40])("reads v%i from corner spacing despite inaccurate local finder pitches", version => {
  const { gray, side, corners } = printedVersion(version);
  expect(readRectifiedQrVersion(gray, side, corners)).toBe(version);
  // Small decoder/quantization changes cannot change the public version.
  gray.forEach((value, i) => { gray[i] = value + (i % 3) - 1; });
  expect(readRectifiedQrVersion(gray, side, corners)).toBe(version);
});

it("requires printed BCH evidence instead of guessing the grid size from the corners", () => {
  const { gray, side, corners } = printedVersion(31);
  gray.fill(245);
  expect(readRectifiedQrVersion(gray, side, corners)).toBeUndefined();
  gray.fill(0);
  expect(readRectifiedQrVersion(gray, side, corners)).toBeUndefined();
});

it.each([
  ["shadow", 173, 229], ["pale ink", 240, 253], ["low contrast", 204, 216],
])("calibrates %s from public finder contrast after the fixed cut misses", (_label, ink, paper) => {
  const { gray, side, corners } = printedVersion(31, { ink, paper, finders: true });
  const original = gray.slice();
  expect(readRectifiedQrVersion(gray, side, corners)).toBe(31);
  expect(gray.every((value, index) => value === original[index])).toBe(true);
  // A small color-management/quantization shift moves both ink and paper;
  // it must not force the public field back across one absolute threshold.
  for (let i = 0; i < gray.length; i++) gray[i] += i % 3 - 1;
  expect(readRectifiedQrVersion(gray, side, corners)).toBe(31);
});

it.each(["topRight", "bottomLeft"])("needs only the visible %s version field", field => {
  const { gray, side, corners } = printedVersion(31, { ink: 180, paper: 225, finders: true, field });
  expect(readRectifiedQrVersion(gray, side, corners)).toBe(31);
});

it("calibrates the shadowed corner locally rather than combining unlike finder levels", () => {
  const { gray, side, corners } = printedVersion(31, {
    ink: 220, paper: 250, finders: true, shadow: true, field: "bottomLeft",
  });
  expect(readRectifiedQrVersion(gray, side, corners)).toBe(31);
});

it("uses within-module medians instead of a single damaged center pixel", () => {
  const { gray, side, corners, map, size } = printedVersion(31, {
    ink: 180, paper: 225, finders: true, accuratePitch: true, shear: 0,
  });
  // With exact pitch and no shear, local-pitch and corner-spacing maps share
  // the damaged center. Only a within-module vote can recover its observation.
  for (const transpose of [false, true]) for (let i = 0; i < 18; i++) {
    const point = map((transpose ? Math.floor(i / 3) : size - 11 + i % 3) + 0.5,
      (transpose ? size - 11 + i % 3 : Math.floor(i / 3)) + 0.5);
    const at = Math.round(point.y) * side + Math.round(point.x);
    gray[at] = gray[at] === 180 ? 225 : 180;
  }
  expect(readRectifiedQrVersion(gray, side, corners)).toBe(31);
});

it.each([0, 1, 2, 3, 4])("keeps the three-bit BCH correction limit (%i damaged bits)", errors => {
  const word = encodedVersion(31) ^ ((1 << errors) - 1);
  if (errors === 4) for (let version = 7; version <= 40; version++) {
    let bits = word ^ encodedVersion(version), distance = 0;
    while (bits) { distance++; bits &= bits - 1; }
    expect(distance).toBeGreaterThan(3);
  }
  const { gray, side, corners } = printedVersion(31, {
    ink: 180, paper: 225, finders: true, accuratePitch: true,
    word,
  });
  expect(readRectifiedQrVersion(gray, side, corners)).toBe(errors <= 3 ? 31 : undefined);
});

it.each([0, 225])("does not reconstruct a covered or blank field from finders (%i)", fieldValue => {
  const { gray, side, corners } = printedVersion(31, {
    ink: 180, paper: 225, finders: true, fieldValue,
  });
  expect(readRectifiedQrVersion(gray, side, corners)).toBeUndefined();
});

it.each([6, 7, 41])("rejects unsupported or geometrically implausible encoded version %i", version => {
  const { gray, side, corners } = printedVersion(31, {
    ink: 180, paper: 225, finders: true, word: encodedVersion(version), accuratePitch: true,
  });
  expect(readRectifiedQrVersion(gray, side, corners)).toBeUndefined();
});

it("requires usable finder contrast for the calibrated retry", () => {
  const { gray, side, corners } = printedVersion(31, { ink: 180, paper: 225 });
  expect(readRectifiedQrVersion(gray, side, corners)).toBeUndefined();
  gray.fill(80);
  expect(readRectifiedQrVersion(gray, side, corners)).toBeUndefined();
});

it.each([7, 17, 27, 40])("calibrates public fields across supported grid sizes (v%i)", version => {
  const { gray, side, corners } = printedVersion(version, { ink: 180, paper: 225, finders: true });
  expect(readRectifiedQrVersion(gray, side, corners)).toBe(version);
});

it.each([
  ["flat", 225, 225], ["too little contrast", 220, 225],
  ["reversed", 225, 180], ["foreground", 50, 80],
])("rejects %s finder evidence even with a printed version field", (_label, finderInk, finderPaper) => {
  const { gray, side, corners } = printedVersion(31, {
    ink: 180, paper: 225, finders: true, finderInk, finderPaper,
  });
  expect(readRectifiedQrVersion(gray, side, corners)).toBeUndefined();
});

it.each([["bottomLeft", 1], ["topRight", 2]])(
  "can use the %s field when the other finder is unavailable", (field, unavailableFinder) => {
    const { gray, side, corners } = printedVersion(31, {
      ink: 180, paper: 225, finders: true, field, unavailableFinder,
    });
    expect(readRectifiedQrVersion(gray, side, corners)).toBe(31);
  });

it("bounds the calibrated retry by public modules rather than image area", () => {
  const { gray, side, corners } = printedVersion(31, { ink: 180, paper: 225, finders: true });
  let reads = 0;
  const observed = new Proxy(gray, { get: (target, key) => { reads++; return target[key]; } });
  expect(readRectifiedQrVersion(observed, side, corners)).toBe(31);
  // Even checking every allowed size, two fields and both maps is bounded.
  expect(reads).toBeLessThan(15000);
});
