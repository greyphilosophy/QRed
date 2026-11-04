import { beforeEach, expect, it, vi } from "vitest";
import { scanQrImage } from "../qr/scanQrImage.js";
import { preparePhotoReadingPixels } from "./photoReadingPixels.js";

vi.mock("../qr/scanQrImage.js", () => ({ scanQrImage: vi.fn(() => null) }));
beforeEach(() => scanQrImage.mockReset().mockReturnValue(null));
const frame = () => ({ width: 200, height: 200, data: new Uint8ClampedArray(200 * 200 * 4).fill(100) });
const location = { topLeftCorner: { x: 20, y: 20 }, topRightCorner: { x: 60, y: 20 },
  bottomLeftCorner: { x: 20, y: 60 }, bottomRightCorner: { x: 60, y: 60 } };

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
