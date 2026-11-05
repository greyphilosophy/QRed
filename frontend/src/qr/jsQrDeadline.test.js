import { PNG } from "pngjs";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { describe, expect, it } from "vitest";

const options = { inversionAttempts: "attemptBoth" };
const width = 64, height = 64;
const blank = new Uint8ClampedArray(width * height * 4).fill(255);
// One entry checkpoint, grayscale columns, then both 8-pixel region passes.
// Location follows those passes and checks each row and long-row segments.
const binarizationChecks = 1 + width + 2 * Math.ceil(height / 8);

function cancelAt(data, w, h, stopAt) {
  let checks = 0;
  const result = jsQR(data, w, h, {
    ...options, shouldContinue: () => ++checks < stopAt,
  });
  expect(result).toBeNull();
  expect(checks).toBe(stopAt);
}

describe("real jsQR cooperative photo deadlines", () => {
  it("returns before touching image pixels when already expired", () => {
    let checks = 0;
    const unreadable = { get length() { throw new Error("Image was accessed"); } };
    expect(jsQR(unreadable, width, height, {
      ...options, shouldContinue: () => { checks++; return false; },
    })).toBeNull();
    expect(checks).toBe(1);
  });

  it.each([
    ["grayscale columns", 5],
    ["black-point rows", 1 + width + 3],
    ["threshold rows", 1 + width + Math.ceil(height / 8) + 3],
    ["locator rows", binarizationChecks + 20],
  ])("stops during %s without returning a partial decode", (_stage, stopAt) => {
    cancelAt(blank, width, height, stopAt);
    expect(blank.every(value => value === 255)).toBe(true);
  });

  it.each([1, 5, binarizationChecks + 20])("propagates callback errors at checkpoint %i", stopAt => {
    const failure = new Error("Caller deadline failed");
    let checks = 0;
    expect(() => jsQR(blank, width, height, {
      ...options,
      shouldContinue: () => { if (++checks === stopAt) throw failure; return true; },
    })).toThrow(failure);
    expect(checks).toBe(stopAt);
  });

  it("does not swallow normal malformed-data errors", () => {
    for (const extra of [{}, { shouldContinue: () => true }]) {
      expect(() => jsQR(new Uint8ClampedArray(4), width, height, { ...options, ...extra }))
        .toThrow("Malformed data passed to binarizer");
    }
  });

  it.each([
    ["ordinary", "https://example.test/deadline", {}],
    ["dense v23", "Corrected message bytes remain authoritative. ".repeat(15), { version: 23 }],
    ["inverted", "An inverted conventional QR", { inverted: true }],
  ])("preserves complete %s results with an always-open deadline", async (_name, text, settings) => {
    const { inverted, ...qrOptions } = settings;
    const image = PNG.sync.read(await QRCode.toBuffer(text, { scale: 4, margin: 4, ...qrOptions }));
    if (inverted) for (let i = 0; i < image.data.length; i += 4) {
      for (let channel = 0; channel < 3; channel++) image.data[i + channel] = 255 - image.data[i + channel];
    }
    const original = image.data.slice();
    const baseline = jsQR(image.data, image.width, image.height, options);
    let checks = 0;
    const bounded = jsQR(image.data, image.width, image.height, {
      ...options, shouldContinue: () => { checks++; return true; },
    });
    expect(baseline?.data).toBe(text);
    expect(bounded).toEqual(baseline);
    expect(checks).toBeGreaterThan(image.width + image.height);
    expect(image.data.equals(original)).toBe(true);
  });

  it("checks after a module sampler and preserves errors from that sampler", async () => {
    const image = PNG.sync.read(await QRCode.toBuffer("Stop before decoding a sampled matrix", { scale: 4 }));
    let running = true, samples = 0;
    expect(jsQR(image.data, image.width, image.height, {
      ...options,
      shouldContinue: () => running,
      moduleSampler: matrix => { samples++; running = false; return matrix; },
    })).toBeNull();
    expect(samples).toBe(1);
    const failure = new Error("Sampler failed");
    expect(() => jsQR(image.data, image.width, image.height, {
      ...options, shouldContinue: () => true, moduleSampler: () => { throw failure; },
    })).toThrow(failure);
    expect(jsQR(image.data, image.width, image.height, options)?.data)
      .toBe("Stop before decoding a sampled matrix");
  });

  it("keeps cancellation local to the invocation", async () => {
    const image = PNG.sync.read(await QRCode.toBuffer("Nested decoder result", { scale: 4 }));
    let nested = false;
    const result = jsQR(image.data, image.width, image.height, {
      ...options,
      shouldContinue: () => {
        if (!nested) {
          nested = true;
          expect(jsQR(blank, width, height, { ...options, shouldContinue: () => false })).toBeNull();
        }
        return true;
      },
    });
    expect(result?.data).toBe("Nested decoder result");
  });
});
