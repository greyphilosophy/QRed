import { beforeEach, expect, it, vi } from "vitest";
import { scanQrImage } from "../qr/scanQrImage.js";
import { preparePhotoReadingPixels } from "./photoReadingPixels.js";

vi.mock("../qr/scanQrImage.js", () => ({ scanQrImage: vi.fn(() => null) }));
beforeEach(() => scanQrImage.mockReset().mockReturnValue(null));
const frame = () => ({ width: 200, height: 200, data: new Uint8ClampedArray(200 * 200 * 4).fill(100) });
const location = { topLeftCorner: { x: 20, y: 20 }, topRightCorner: { x: 60, y: 20 },
  bottomLeftCorner: { x: 20, y: 60 }, bottomRightCorner: { x: 60, y: 60 } };

it("locates warm, shadowed paper before making the contrast copy", () => {
  const width = 800, height = 1000, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inside = x >= 34 && x < 774 && y >= 60 && y < 960;
    const ink = y % 600 >= 124 && y % 600 < 130 ? (x >= 300 && x < 360 ? .25 : x >= 380 && x < 440 ? .8 : 1) : 1;
    const light = inside ? 220 * (1 - y / height * .4) * ink : 170 + (x * 7 + y * 11) % 20;
    const tint = inside ? [1.05, 1, .95] : [1.1, 1, .9];
    const offset = (y * width + x) * 4;
    for (let channel = 0; channel < 3; channel++) data[offset + channel] = light * tint[channel];
    data[offset + 3] = 255;
  }
  const { corners } = preparePhotoReadingPixels({ data, width, height });
  expect(corners).toHaveLength(4);
  const expected = [[34, 60], [774, 60], [774, 960], [34, 960]];
  corners.forEach((point, i) => {
    expect(Math.abs(point.x - expected[i][0])).toBeLessThan(5);
    expect(Math.abs(point.y - expected[i][1])).toBeLessThan(5);
  });
  for (const y of [126, 726]) {
    expect(data[(y * width + 320) * 4]).toBeLessThan(35);
    expect(data[(y * width + 400) * 4]).toBe(255);
  }
});

it("only removes pale ink in the contrast copy and bounds a no-code search to one attempt", () => {
  const image = frame(); image.data.set([224, 224, 224, 255], 0);
  const { image: prepared, codes } = preparePhotoReadingPixels(image);
  expect([...prepared.data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
  expect(prepared.data[4]).toBe(100);
  expect(codes).toEqual([]);
  expect(scanQrImage).toHaveBeenCalledTimes(1);
  expect(scanQrImage.mock.calls[0][3]).toEqual({ tryRescaling: false, tryWatermark: false, maxAttempts: 1 });
});

it("keeps all dark ink beneath an identified stamp in the OCR image", () => {
  scanQrImage.mockReturnValueOnce({ data: "QRED.ORG", location });
  const image = frame();
  const result = preparePhotoReadingPixels(image);
  expect(result.codes).toEqual([{ x0: 20, y0: 20, x1: 60, y1: 60, kind: "navigation" }]);
  expect(result.image.data[(40 * 200 + 40) * 4]).toBe(100);
  expect(result.image.data[(40 * 200 + 65) * 4]).toBe(100);
  expect(scanQrImage).toHaveBeenCalledTimes(2);
  expect(scanQrImage.mock.calls[1][0]).not.toBe(result.image.data);
  expect(scanQrImage.mock.calls[1][0].every(value => value === 0)).toBe(true);
});

it("does not classify arbitrary QR content or a page-sized watermark as a small printed marking", () => {
  scanQrImage.mockReturnValueOnce({ data: "https://example.test", location });
  expect(preparePhotoReadingPixels(frame()).codes).toEqual([]);
  const large = Object.fromEntries(Object.entries(location).map(([key, p]) => [key, { x: p.x * 3, y: p.y * 3 }]));
  scanQrImage.mockReturnValueOnce({ data: "QRED.ORG", location: large });
  expect(preparePhotoReadingPixels(frame()).codes).toEqual([]);
});
