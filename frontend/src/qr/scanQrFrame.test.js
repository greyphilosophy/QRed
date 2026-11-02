import jsQR from "jsqr";
import { afterEach, expect, it, vi } from "vitest";
import { createQrFrameScanner } from "./scanQrImage.js";

vi.mock("jsqr", () => ({ default: vi.fn(() => null) }));
afterEach(() => vi.mocked(jsQR).mockReset());

it("limits a live frame to one decode and spreads retries across subsequent frames", () => {
  const scan = createQrFrameScanner();
  const pixels = new Uint8ClampedArray(200 * 200 * 4).fill(255);
  for (let frame = 0; frame < 5; frame += 1) {
    scan(pixels, 200, 200);
    expect(jsQR).toHaveBeenCalledTimes(frame + 1);
  }
  expect(vi.mocked(jsQR).mock.calls.map(([, width, height]) => [width, height])).toEqual([
    [200, 200], [180, 180], [250, 250], [300, 300], [200, 200],
  ]);
});

it("uses one color-aware module pass across live frames instead of reserving it for uploads", () => {
  const scan = createQrFrameScanner();
  const pixels = new Uint8ClampedArray(200 * 200 * 4).fill(255);
  for (let frame = 0; frame < 6; frame++) scan(pixels, 200, 200);
  expect(jsQR).toHaveBeenCalledTimes(6);
  expect(typeof vi.mocked(jsQR).mock.calls.at(-1)[3]?.moduleSampler).toBe("function");
});

it("resets after detection or a resolution change and keeps camera sessions independent", () => {
  const scan = createQrFrameScanner();
  const pixels = new Uint8ClampedArray(200 * 200 * 4);
  scan(pixels, 200, 200);
  createQrFrameScanner()(pixels, 200, 200);
  expect(vi.mocked(jsQR).mock.lastCall.slice(1, 3)).toEqual([200, 200]);

  vi.mocked(jsQR).mockReturnValueOnce({ data: "found" });
  expect(scan(pixels, 200, 200)?.data).toBe("found");
  scan(pixels, 200, 200);
  expect(vi.mocked(jsQR).mock.lastCall.slice(1, 3)).toEqual([200, 200]);
  scan(new Uint8ClampedArray(240 * 240 * 4), 240, 240);
  expect(vi.mocked(jsQR).mock.lastCall.slice(1, 3)).toEqual([240, 240]);
});

it("rejects invalid frames without consuming a retry", () => {
  const scan = createQrFrameScanner();
  expect(scan(new Uint8ClampedArray(), 0, 0)).toBeNull();
  expect(jsQR).not.toHaveBeenCalled();
  scan(new Uint8ClampedArray(200 * 200 * 4), 200, 200);
  expect(vi.mocked(jsQR).mock.lastCall.slice(1, 3)).toEqual([200, 200]);
});

it("uses one fresh frame to skip a navigation QR, then discards its old position", () => {
  const scan = createQrFrameScanner();
  const pixels = new Uint8ClampedArray(200 * 200 * 4);
  const location = { topLeftCorner: { x: 20, y: 20 }, topRightCorner: { x: 50, y: 20 },
    bottomLeftCorner: { x: 20, y: 50 }, bottomRightCorner: { x: 50, y: 50 } };
  jsQR.mockReturnValueOnce({ data: "HTTPS://QRED.ORG", location });
  scan(pixels, 200, 200);
  expect(jsQR).toHaveBeenCalledTimes(1);
  const nextFrame = new Uint8ClampedArray(pixels).fill(80);
  scan(nextFrame, 200, 200);
  expect(jsQR).toHaveBeenCalledTimes(2);
  const retry = jsQR.mock.lastCall[0];
  expect(retry[(25 * 200 + 25) * 4]).toBe(255);
  expect(retry[0]).toBe(80);
  expect(nextFrame.every(value => value === 80)).toBe(true);
  scan(nextFrame, 200, 200);
  expect(jsQR).toHaveBeenCalledTimes(3);
  expect(jsQR.mock.lastCall[0][(25 * 180 + 25) * 4]).toBe(80);
});
