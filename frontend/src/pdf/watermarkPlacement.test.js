import { describe, expect, it } from "vitest";
import { planWatermarks, MIN_WATERMARK_MODULE_SIZE } from "./watermarkPlacement.js";

const symbol = { modules: { size: 177 } };
function pageWithGraphic(graphic, { bounds = { x: 0, y: 0, width: 612, height: 792 }, shade = 0 } = {}) {
  const width = bounds.width, height = bounds.height;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  if (graphic) for (let y = graphic.y; y < graphic.y + graphic.height; y++) for (let x = graphic.x; x < graphic.x + graphic.width; x++) {
    const offset = ((height - 1 - y) * width + x) * 4;
    data[offset] = data[offset + 1] = data[offset + 2] = shade;
  }
  return { data, width, height, scale: 1, bounds };
}
const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

describe("page-aware watermark placement", () => {
  it.each([
    ["top-left", { x: 32, y: 624, width: 120, height: 120 }, 0],
    ["bottom-left", { x: 32, y: 36, width: 120, height: 120 }, 0],
    ["center", { x: 256, y: 346, width: 100, height: 100 }, 0],
    ["left sidebar", { x: 18, y: 150, width: 140, height: 470 }, 0],
    ["right gray sidebar", { x: 454, y: 150, width: 140, height: 470 }, 224],
  ])("uses available space around a %s graphic", (_name, graphic, shade) => {
    const [box] = planWatermarks(pageWithGraphic(graphic, { shade }), [symbol]);
    expect(intersects(box, graphic)).toBe(false);
    expect(box.width / 185).toBeGreaterThanOrEqual(MIN_WATERMARK_MODULE_SIZE);
    expect(box.x).toBeGreaterThanOrEqual(18);
    expect(box.y).toBeGreaterThanOrEqual(18);
    expect(box.x + box.width).toBeLessThanOrEqual(594.001);
    expect(box.y + box.height).toBeLessThanOrEqual(774.001);
  });

  it("keeps the same physical placement when the PDF crop origin changes", () => {
    const graphic = { x: 256, y: 346, width: 100, height: 100 };
    const [plain] = planWatermarks(pageWithGraphic(graphic), [symbol]);
    const [offset] = planWatermarks(pageWithGraphic(graphic, { bounds: { x: 71, y: -37, width: 612, height: 792 } }), [symbol]);
    expect(offset.x - 71).toBeCloseTo(plain.x);
    expect(offset.y + 37).toBeCloseTo(plain.y);
    expect(offset.width).toBeCloseTo(plain.width);
  });

  it("reserves quiet zones, printable margins, and a separate entry code for both parts", () => {
    const entry = { x: 550, y: 18, width: 44, height: 52 };
    const boxes = planWatermarks(pageWithGraphic(null), [symbol, symbol], entry);
    expect(boxes).toHaveLength(2);
    expect(intersects(boxes[0], boxes[1])).toBe(false);
    for (const box of boxes) {
      expect(intersects(box, { x: 542, y: 10, width: 60, height: 68 })).toBe(false);
      expect(box.width / 185).toBeGreaterThanOrEqual(MIN_WATERMARK_MODULE_SIZE);
    }
  });

  it("searches a genuinely different placement after a candidate fails decoding", () => {
    const image = pageWithGraphic({ x: 260, y: 400, width: 90, height: 40 });
    const first = planWatermarks(image, [symbol]);
    const alternate = planWatermarks(image, [symbol], null, { excludeBoxes: first });
    expect(alternate).toHaveLength(1);
    const a = first[0], b = alternate[0];
    const overlapWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const overlapHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    const overlapRatio = overlapWidth * overlapHeight / Math.min(a.width * a.height, b.width * b.height);
    expect(overlapRatio).toBeLessThanOrEqual(0.7);
  });

  it("rejects geometry that cannot meet minimum printed module size", () => {
    const image = pageWithGraphic(null, { bounds: { x: 0, y: 0, width: 200, height: 200 } });
    expect(() => planWatermarks(image, [symbol])).toThrow(/too dense/);
  });
});
