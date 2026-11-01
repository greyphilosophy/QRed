import { describe, expect, it } from "vitest";
import { planWatermarks, MIN_WATERMARK_MODULE_SIZE } from "./watermarkPlacement.js";

const symbol = { modules: { size: 177 } };
const quadrantSymbol = { modules: { size: 125 } }; // v27
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
  ])("places fallback squares around a %s graphic", (_name, graphic, shade) => {
    const [box] = planWatermarks(pageWithGraphic(graphic, { shade }), [symbol], null,
      { preferPageAligned: false });
    expect(intersects(box, graphic)).toBe(false);
    expect(box.width / 185).toBeGreaterThanOrEqual(MIN_WATERMARK_MODULE_SIZE);
    expect(box.x).toBeGreaterThanOrEqual(54);
    expect(box.y).toBeGreaterThanOrEqual(54);
    expect(box.x + box.width).toBeLessThanOrEqual(558.001);
    expect(box.y + box.height).toBeLessThanOrEqual(738.001);
  });

  it.each([1, 4])("tries the full-page layout for %i symbols despite a shaded table heading", count => {
    const image = pageWithGraphic({ x: 32, y: 470, width: 548, height: 18 }, { shade: 243 });
    const boxes = planWatermarks(image, Array(count).fill(quadrantSymbol));
    expect(boxes).toHaveLength(count);
    for (const box of boxes) {
      expect(box.width).toBeCloseTo(count === 1 ? 540 : 270);
      expect(box.height).toBeCloseTo(count === 1 ? 720 : 360);
    }
  });

  it.each([
    ["left", { x: 32, y: 300, width: 12, height: 60 }],
    ["right", { x: 574, y: 300, width: 12, height: 60 }],
    ["top", { x: 250, y: 754, width: 60, height: 12 }],
    ["bottom", { x: 250, y: 30, width: 60, height: 12 }],
  ])("uses half-inch margins when original visible ink reaches the %s edge band", (_edge, graphic) => {
    const [box] = planWatermarks(pageWithGraphic(graphic), [symbol]);
    expect(box.x).toBeCloseTo(36);
    expect(box.y).toBeCloseTo(36);
    expect(box.width).toBeCloseTo(540);
    expect(box.height).toBeCloseTo(720);
  });

  it("keeps the generous margin for blank, wider-margin and isolated-speck pages", () => {
    for (const graphic of [null, { x: 40, y: 300, width: 50, height: 50 },
      { x: 1, y: 1, width: 1, height: 1 }]) {
      const [box] = planWatermarks(pageWithGraphic(graphic), [symbol]);
      expect(box.x).toBeCloseTo(54);
      expect(box.y).toBeCloseTo(54);
      expect(box.width).toBeCloseTo(504);
      expect(box.height).toBeCloseTo(684);
    }
  });

  it("keeps a half-inch floor even for artwork running to the page edge", () => {
    const [box] = planWatermarks(pageWithGraphic({ x: 0, y: 0, width: 612, height: 792 },
      { bounds: { x: 71, y: -37, width: 612, height: 792 }, shade: 240 }), [symbol]);
    expect(box.x).toBeCloseTo(71 + 36);
    expect(box.y).toBeCloseTo(-37 + 36);
    expect(box.width).toBeCloseTo(540);
    expect(box.height).toBeCloseTo(720);
  });

  it("keeps the same physical placement when the PDF crop origin changes", () => {
    const graphic = { x: 256, y: 346, width: 100, height: 100 };
    const options = { preferPageAligned: false };
    const [plain] = planWatermarks(pageWithGraphic(graphic), [symbol], null, options);
    const [offset] = planWatermarks(pageWithGraphic(graphic, { bounds: { x: 71, y: -37, width: 612, height: 792 } }), [symbol], null, options);
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

  it("fits four version-27 symbols inside a 0.75-inch margin on letter paper", () => {
    const boxes = planWatermarks(pageWithGraphic(null),
      [quadrantSymbol, quadrantSymbol, quadrantSymbol, quadrantSymbol]);
    expect(boxes).toHaveLength(4);
    for (let i = 0; i < boxes.length; i++) {
      expect(boxes[i].width / 125).toBeGreaterThanOrEqual(MIN_WATERMARK_MODULE_SIZE);
      expect(boxes[i].x).toBeGreaterThanOrEqual(54 - 0.001);
      expect(boxes[i].y).toBeGreaterThanOrEqual(54 - 0.001);
      expect(boxes[i].x + boxes[i].width).toBeLessThanOrEqual(558.001);
      expect(boxes[i].y + boxes[i].height).toBeLessThanOrEqual(738.001);
      for (let j = i + 1; j < boxes.length; j++) expect(intersects(boxes[i], boxes[j])).toBe(false);
    }
    expect(boxes[0].y).toBeGreaterThan(boxes[2].y);
    expect(boxes[1].x).toBeGreaterThan(boxes[0].x);
  });

  it("rejects four version-40 symbols when safe-margin modules would be too small", () => {
    expect(() => planWatermarks(pageWithGraphic(null), [symbol, symbol, symbol, symbol]))
      .toThrow(/too dense/i);
  });

  it("does not call four content-avoiding squares a standardized page-filling grid", () => {
    const image = pageWithGraphic({ x: 254, y: 335, width: 106, height: 120 });
    const boxes = planWatermarks(image,
      [quadrantSymbol, quadrantSymbol, quadrantSymbol, quadrantSymbol], null,
      { preferPageAligned: false });
    expect(boxes).toHaveLength(4);
    for (const box of boxes) expect(box.width).toBeCloseTo(box.height);
  });

  it("searches a genuinely different placement after a candidate fails decoding", () => {
    const image = pageWithGraphic({ x: 260, y: 400, width: 90, height: 40 });
    // Exercise the legacy placement retry rather than the new standardized
    // page-filling grid, which necessarily occupies nearly all the page.
    const first = planWatermarks(image, [symbol], null, { preferPageAligned: false });
    const alternate = planWatermarks(image, [symbol], null, { excludeBoxes: first, preferPageAligned: false });
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
