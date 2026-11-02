import jsQR from "jsqr";
import { beforeEach, expect, it, vi } from "vitest";
import { encodeChunk, sealString } from "../sealFormat.js";
import { createQrFrameScanner } from "./scanQrImage.js";
import { scanPageAlignedImage } from "./pageAlignedScan.js";

vi.mock("jsqr", () => ({ default: vi.fn(() => null) }));
vi.mock("./pageAlignedScan.js", () => ({ scanPageAlignedImage: vi.fn(() => []) }));
beforeEach(() => {
  vi.mocked(jsQR).mockReset().mockReturnValue(null);
  vi.mocked(scanPageAlignedImage).mockReset().mockReturnValue([]);
});

const pixels = new Uint8ClampedArray(200 * 200 * 4).fill(255);
const frame = scan => scan(pixels, 200, 200);
const widths = () => jsQR.mock.calls.map(([, width]) => width);
function chunk(index = 0) {
  // A recognizable transport is only a scheduling hint; signature validation
  // stays with the verifier. Real signed PDF fixtures cover that integration.
  const bytes = encodeChunk(new Uint8Array(32).fill(23), index, 4,
    Uint8Array.from([0, 255, 128, index]));
  return { data: "", binaryData: Array.from(bytes) };
}

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

it.each(["binary", "URL"])("reuses a successful scale for the next %s seal", format => {
  const scan = createQrFrameScanner();
  const first = chunk(0), second = chunk(1);
  if (format === "URL") {
    first.data = sealString(Uint8Array.from(first.binaryData));
    delete first.binaryData;
  }
  jsQR.mockReturnValueOnce(null).mockReturnValueOnce(first).mockReturnValueOnce(second);
  expect(frame(scan)).toBeNull();
  expect(frame(scan)).toEqual(first);
  expect(frame(scan)).toEqual(second);
  expect(widths()).toEqual([200, 180, 180]);
});

it("falls back immediately after the preferred strategy misses on a fresh frame", () => {
  const scan = createQrFrameScanner();
  jsQR.mockReturnValueOnce(null).mockReturnValueOnce(chunk());
  frame(scan); frame(scan);
  const fresh = new Uint8ClampedArray(pixels.length).fill(80);
  expect(scan(fresh, 200, 200)).toBeNull();
  expect(jsQR.mock.lastCall[0][0]).toBe(80);
  const nextPage = chunk(1);
  jsQR.mockReturnValueOnce(nextPage);
  expect(scan(fresh, 200, 200)).toEqual(nextPage);
  expect(widths()).toEqual([200, 180, 180, 200]);
  jsQR.mockReturnValueOnce(chunk(2));
  scan(fresh, 200, 200);
  expect(widths().at(-1)).toBe(200);
});

it("preserves module-aware recovery when that strategy is preferred", () => {
  const scan = createQrFrameScanner();
  jsQR.mockImplementation((data, width, height, options) => options.moduleSampler ? chunk() : null);
  for (let i = 0; i < 5; i++) expect(frame(scan)).toBeNull();
  expect(frame(scan)).toMatchObject({ moduleAware: true, watermark: true });
  expect(frame(scan)).toMatchObject({ moduleAware: true, watermark: true });
  expect(jsQR).toHaveBeenCalledTimes(7);
  expect(typeof jsQR.mock.lastCall[3].moduleSampler).toBe("function");
});

it("lets other strategies run after the preferred strategy repeats the same seal", () => {
  const scan = createQrFrameScanner();
  jsQR.mockReturnValueOnce(null).mockReturnValueOnce(chunk()).mockReturnValueOnce(chunk());
  frame(scan); frame(scan); frame(scan);
  // All remaining strategies, including shallow page alignment, must get a
  // turn even if the preferred strategy continues to see the same chunk.
  jsQR.mockImplementation((data, width) => width === 180 ? chunk() : null);
  for (let i = 0; i < 9; i++) frame(scan);
  expect(widths().slice(0, 4)).toEqual([200, 180, 180, 200]);
  expect(scanPageAlignedImage).toHaveBeenCalledTimes(1);
  expect(jsQR.mock.calls.some(([, , , options]) => options.moduleSampler)).toBe(true);
});

it("reaches full-page recovery when different strategies keep returning different old chunks", () => {
  const scan = createQrFrameScanner();
  jsQR.mockImplementation((data, width) => width === 200 ? chunk(0) : width === 180 ? chunk(1) : null);
  const remaining = [chunk(2), chunk(3)];
  scanPageAlignedImage.mockReturnValue(remaining.map(code => ({ code })));
  let result;
  for (let i = 0; i < 15 && !result?.codes; i++) result = frame(scan);
  expect(result).toEqual({ codes: remaining });
  expect(scanPageAlignedImage).toHaveBeenCalledTimes(1);
});

it("keeps every fallback reachable when a learned strategy stops working", () => {
  const scan = createQrFrameScanner();
  jsQR.mockReturnValueOnce(null).mockReturnValueOnce(chunk());
  frame(scan); frame(scan);
  jsQR.mockClear();
  for (let i = 0; i < 10; i++) expect(frame(scan)).toBeNull();
  expect(jsQR).toHaveBeenCalledTimes(9);
  expect(widths()).toEqual([180, 200, 250, 300, 200, 200, 200, 180, 250]);
  expect(scanPageAlignedImage).toHaveBeenCalledTimes(1);
  expect(scanPageAlignedImage).toHaveBeenCalledWith(
    { data: pixels, width: 200, height: 200 }, { deep: false });
});

it.each([
  { data: "https://example.test" }, { data: "QRED4:invalid" },
  { data: "QRED.ORG" }, { data: "", binaryData: [1, 2, 3] },
])("does not learn a preference from unrelated or malformed content: %j", code => {
  const scan = createQrFrameScanner();
  jsQR.mockReturnValue(code);
  for (let i = 0; i < 10; i++) frame(scan);
  expect(widths().slice(0, 4)).toEqual([200, 180, 250, 300]);
  expect(scanPageAlignedImage).toHaveBeenCalledTimes(1);
});

it("reuses shallow page alignment and returns only the current frame's batch", () => {
  const scan = createQrFrameScanner();
  const first = [chunk(0), chunk(1)], second = [chunk(2), chunk(3)];
  scanPageAlignedImage.mockReturnValueOnce(first.map(code => ({ code })))
    .mockReturnValueOnce(second.map(code => ({ code })));
  for (let i = 0; i < 9; i++) expect(frame(scan)).toBeNull();
  expect(frame(scan)).toEqual({ codes: first });
  const fresh = new Uint8ClampedArray(pixels.length).fill(80);
  expect(scan(fresh, 200, 200)).toEqual({ codes: second });
  expect(scanPageAlignedImage.mock.lastCall).toEqual([
    { data: fresh, width: 200, height: 200 }, { deep: false },
  ]);
  expect(scan(fresh, 200, 200)).toBeNull();
  expect(scanPageAlignedImage).toHaveBeenCalledTimes(3);
});

it("continues exploring after a duplicate page-aligned batch even if its order changes", () => {
  const scan = createQrFrameScanner();
  const batch = [chunk(0), chunk(1)];
  scanPageAlignedImage.mockReturnValueOnce(batch.map(code => ({ code })))
    .mockReturnValueOnce([...batch].reverse().map(code => ({ code })));
  for (let i = 0; i < 11; i++) frame(scan);
  frame(scan);
  expect(scanPageAlignedImage).toHaveBeenCalledTimes(2);
  expect(jsQR.mock.lastCall.slice(1, 3)).toEqual([200, 200]);
});

it("forgets learned strategies on a resolution change and keeps sessions independent", () => {
  const scan = createQrFrameScanner();
  jsQR.mockReturnValueOnce(null).mockReturnValueOnce(chunk());
  frame(scan); frame(scan);
  frame(createQrFrameScanner());
  expect(vi.mocked(jsQR).mock.lastCall.slice(1, 3)).toEqual([200, 200]);
  frame(scan);
  expect(vi.mocked(jsQR).mock.lastCall.slice(1, 3)).toEqual([180, 180]);
  jsQR.mockReturnValueOnce(chunk());
  scan(new Uint8ClampedArray(240 * 240 * 4), 240, 240);
  scan(new Uint8ClampedArray(240 * 240 * 4), 240, 240);
  expect(vi.mocked(jsQR).mock.lastCall.slice(1, 3)).toEqual([240, 240]);
});

it("rejects invalid frames without consuming a retry", () => {
  const scan = createQrFrameScanner();
  expect(scan(new Uint8ClampedArray(), 0, 0)).toBeNull();
  expect(jsQR).not.toHaveBeenCalled();
  scan(new Uint8ClampedArray(200 * 200 * 4), 200, 200);
  expect(vi.mocked(jsQR).mock.lastCall.slice(1, 3)).toEqual([200, 200]);
  jsQR.mockReturnValueOnce(chunk());
  frame(scan);
  expect(scan(pixels, 240, 240)).toBeNull();
  frame(scan);
  expect(widths()).toEqual([200, 180, 180]);
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
