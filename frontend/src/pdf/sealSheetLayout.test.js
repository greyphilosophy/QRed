import { PageSizes } from "pdf-lib";
import { expect, it } from "vitest";
import { planSealSheetLayout } from "./sealSheetLayout.js";

it.each([PageSizes.Letter, PageSizes.A4])("preserves four-module quiet zones for one to six seals on %s x %s paper", (width, height) => {
  for (let count = 1; count <= 6; count++) {
    for (const versions of [[21], [77], [165], [177], [21, 177, 77, 165]]) {
      const modules = Array.from({ length: count }, (_, index) => versions[index % versions.length]);
      const boxes = planSealSheetLayout(width, height, modules);
      expect(boxes).toHaveLength(count);
      for (const [index, box] of boxes.entries()) {
        const quiet = 4 * box.width / modules[index];
        expect(box.width).toBe(box.height);
        expect(box.width).toBeGreaterThan(0);
        expect(box.x).toBeGreaterThanOrEqual(Math.max(54, quiet) - 1e-6);
        expect(box.x + box.width + Math.max(54, quiet)).toBeLessThanOrEqual(width + 1e-6);
        expect(box.y).toBeGreaterThanOrEqual(Math.max(18, quiet) - 1e-6);
        expect(box.y + box.height + quiet).toBeLessThanOrEqual(height - 150 + 1e-6);
        for (let otherIndex = index + 1; otherIndex < boxes.length; otherIndex++) {
          const other = boxes[otherIndex];
          const separation = Math.max(quiet, 4 * other.width / modules[otherIndex]) - 1e-6;
          expect(box.x + box.width + separation <= other.x || other.x + other.width + separation <= box.x ||
            box.y + box.height + separation <= other.y || other.y + other.height + separation <= box.y).toBe(true);
        }
      }
    }
  }
});

it.each([PageSizes.Letter, PageSizes.A4])("shares internal quiet zones and uses the bottom margin on %s x %s paper", (width, height) => {
  const layout = count => planSealSheetLayout(width, height, Array(count).fill(165));
  const six = layout(6), quiet = 4 * six[0].width / 165;
  // One shared quiet zone, not one border per code plus a separate gutter.
  expect(six[1].x - (six[0].x + six[0].width)).toBeCloseTo(quiet, 2);
  expect(six[0].y - (six[2].y + six[2].height)).toBeCloseTo(quiet, 2);
  expect(six[4].y).toBeCloseTo(18);
  expect(new Set(six.map(box => box.y)).size).toBe(3);
  expect(new Set(six.map(box => box.x)).size).toBe(2);
  const fourSize = layout(4)[0].width;
  expect(six.every(box => box.width < fourSize)).toBe(true);
  expect(layout(1)[0].width).toBeGreaterThan(2 * fourSize);
  expect(layout(2).every(box => box.width > fourSize)).toBe(true);
  expect(layout(3)[2].width).toBeGreaterThan(fourSize);
  expect(layout(5)[4].x + layout(5)[4].width / 2).toBeCloseTo(width / 2);
});

it.each([0, 7, 8])("rejects a sheet with %s seals instead of shrinking a crowded grid", count => {
  expect(() => planSealSheetLayout(...PageSizes.Letter, Array(count).fill(165))).toThrow(RangeError);
});
