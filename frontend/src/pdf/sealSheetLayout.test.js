import { PageSizes } from "pdf-lib";
import { expect, it } from "vitest";
import { planSealSheetLayout } from "./sealSheetLayout.js";

it.each([PageSizes.Letter, PageSizes.A4])("keeps one to six seals, labels and quiet zones inside %s x %s paper", (width, height) => {
  for (let count = 1; count <= 6; count++) {
    const boxes = planSealSheetLayout(width, height, count);
    expect(boxes).toHaveLength(count);
    for (const [index, box] of boxes.entries()) {
      expect(box.width).toBe(box.height);
      expect(box.x).toBeGreaterThanOrEqual(54);
      expect(box.x + box.width).toBeLessThanOrEqual(width - 54);
      expect(box.y).toBeGreaterThanOrEqual(48);
      expect(box.labelY + 11).toBeLessThanOrEqual(height - 162);
      expect(box.labelY - 13).toBeGreaterThan(box.y + box.height);
      for (const other of boxes.slice(index + 1)) {
        expect(box.x + box.width + 18 <= other.x || other.x + other.width + 18 <= box.x ||
          box.labelY + 11 + 18 <= other.y || other.labelY + 11 + 18 <= box.y).toBe(true);
      }
    }
  }
  const fullSize = planSealSheetLayout(width, height, 4)[0].width;
  expect(fullSize).toBeCloseTo((width - 126) / 2); // Retain the previous full-sheet seal size.
  expect(planSealSheetLayout(width, height, 1)[0].width).toBeGreaterThan(2 * fullSize);
  expect(planSealSheetLayout(width, height, 2).every(box => box.width > fullSize)).toBe(true);
  expect(planSealSheetLayout(width, height, 3)[2].width).toBeGreaterThan(fullSize);
  const six = planSealSheetLayout(width, height, 6);
  expect(new Set(six.map(box => box.y)).size).toBe(3);
  expect(new Set(six.map(box => box.x)).size).toBe(2);
  expect(six.every(box => box.width < fullSize)).toBe(true);
  expect(planSealSheetLayout(width, height, 5)[4].x + six[0].width / 2).toBeCloseTo(width / 2);
});

it.each([0, 7, 8, 1.5])("rejects a sheet with %s seals instead of shrinking a crowded grid", count => {
  expect(() => planSealSheetLayout(...PageSizes.Letter, count)).toThrow(RangeError);
});
