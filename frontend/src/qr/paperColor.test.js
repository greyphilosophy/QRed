import { describe, expect, it } from "vitest";
import { estimatePaperColor } from "./paperColor.js";
import { isChromaticForeground } from "./watermarkFilter.js";

function paper(rgb) {
  const width = 101, height = 101;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
  return { data, width, height };
}

describe("paper-relative photo color", () => {
  it.each([[210, 200, 175], [175, 200, 210]])("accepts neutral paper under cast %j while retaining colored text", (...rgb) => {
    const image = paper(rgb);
    const original = image.data.slice();
    // Several of the central probes land on black text.
    for (const u of [0.3, 0.4, 0.5]) {
      image.data.set([20, 20, 20], (30 * image.width + Math.round(u * 100)) * 4);
    }
    const gains = estimatePaperColor(image);
    expect(isChromaticForeground(image.data, 0)).toBe(true);
    expect(isChromaticForeground(image.data, 0, gains)).toBe(false);
    for (const ink of [[30, 80, 190], [190, 40, 30], [210, 180, 30]]) {
      const lit = new Uint8ClampedArray(ink.map((value, i) => value * rgb[i] / 200));
      expect(isChromaticForeground(lit, 0, gains)).toBe(true);
    }
    expect(image.data.subarray(0, 4)).toEqual(original.subarray(0, 4));
  });

  it.each([[60, 90, 180], [255, 255, 255], [40, 40, 40]])("does not infer paper tint from saturated, clipped, or dark samples %j", (...rgb) => {
    expect(estimatePaperColor(paper(rgb))).toEqual([1, 1, 1]);
  });
});
