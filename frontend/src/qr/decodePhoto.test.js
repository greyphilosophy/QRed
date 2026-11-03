import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createQRedSeals } from "../qredSealer.js";
import { createQRedQrData } from "../qredQr.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { decodePhoto } from "./decodePhoto.js";
import { scanQrImage, scanWatermarkPreview } from "./scanQrImage.js";
import { scanPageAlignedImage } from "./pageAlignedScan.js";
import { scanRectifiedSeal } from "./rectifiedSealScan.js";

vi.mock("./scanQrImage.js", () => ({ scanQrImage: vi.fn(), scanWatermarkPreview: vi.fn() }));
vi.mock("./pageAlignedScan.js", () => ({ scanPageAlignedImage: vi.fn() }));
vi.mock("./rectifiedSealScan.js", () => ({ scanRectifiedSeal: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";
const image = { width: 320, height: 240, data: new Uint8ClampedArray(320 * 240 * 4) };
let single, multiple;
function code(seal) {
  const { payloadBytes, version } = createQRedQrData(seal);
  return { data: "", binaryData: Array.from(payloadBytes), version };
}
beforeAll(async () => {
  const options = { privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", publicKey,
    timestamp: "2026-11-01T12:00:00Z", pageContext: { pageNumber: 1, pageCount: 1 } };
  single = (await createQRedSeals({ ...options, content: "Fast photo recovery" })).seals[0];
  multiple = (await createQRedSeals({ ...options, content: "Four printed watermark chunks. ".repeat(160),
    encodingStrategy: "plaintext", preferFourQrPage: true })).seals;
  expect(multiple).toHaveLength(4);
});
beforeEach(() => {
  scanWatermarkPreview.mockReset().mockReturnValue(null);
  scanPageAlignedImage.mockReset().mockReturnValue([]);
  scanRectifiedSeal.mockReset().mockReturnValue(null);
  scanQrImage.mockReset().mockReturnValue(null);
});

it("returns a complete preview seal after a quick page miss and still requires signature verification", async () => {
  scanWatermarkPreview.mockReturnValue(code(single));
  const action = decodePhoto(image, { returnPayload: true });
  expect(action).toEqual({ status: "found", text: single });
  expect(scanPageAlignedImage).not.toHaveBeenCalled();
  expect(scanQrImage).not.toHaveBeenCalled();
  expect(scanRectifiedSeal).toHaveBeenCalledTimes(1);
  expect(scanRectifiedSeal.mock.invocationCallOrder[0]).toBeLessThan(scanWatermarkPreview.mock.invocationCallOrder[0]);
  expect((await verifyQRedSeals([action.text], publicKey)).status).toBe("VALID");
  expect((await verifyQRedSeals([action.text], "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI")).status).toBe("INVALID");
});

it.each(["HTTPS://QRED.ORG", "https://example.test"])("continues watermark recovery after a preview reads %s", data => {
  scanWatermarkPreview.mockReturnValue({ data });
  scanPageAlignedImage.mockReturnValue([{ seal: single }]);
  expect(decodePhoto(image, { returnPayload: true })).toEqual({ status: "found-multiple", texts: [single] });
  expect(scanPageAlignedImage).toHaveBeenCalledWith(image, { deep: true, shouldContinue: expect.any(Function) });
});

it("collects all four chunks even when the preview has already read one", () => {
  scanWatermarkPreview.mockReturnValue(code(multiple[2]));
  scanPageAlignedImage.mockReturnValue(multiple.map(seal => ({ seal })));
  expect(decodePhoto(image, { returnPayload: true })).toEqual({ status: "found-multiple", texts: multiple });
});

it("keeps original-resolution alignment and legacy recovery after a preview miss", () => {
  scanQrImage.mockReturnValueOnce(null).mockReturnValue(code(single));
  expect(decodePhoto(image, { returnPayload: true })).toEqual({ status: "found", text: single });
  expect(scanPageAlignedImage.mock.calls[0][0]).toBe(image);
  expect(scanQrImage).toHaveBeenCalledWith(image.data, image.width, image.height,
    { shouldContinue: expect.any(Function) });
});

it("recovers a complete ordinary footer seal before exhaustive alignment", async () => {
  scanQrImage.mockReturnValue(code(single));
  const action = decodePhoto(image, { returnPayload: true });
  expect(action).toEqual({ status: "found", text: single });
  expect(scanPageAlignedImage).not.toHaveBeenCalled();
  expect(scanQrImage).toHaveBeenCalledTimes(1);
  expect(scanQrImage).toHaveBeenCalledWith(image.data, image.width, image.height,
    { tryRescaling: false, tryWatermark: false, maxAttempts: 2, shouldContinue: expect.any(Function) });
  expect((await verifyQRedSeals([action.text], publicKey)).status).toBe("VALID");
});

it("does not let a single footer chunk skip collection of the remaining chunks", () => {
  scanQrImage.mockReturnValue(code(multiple[0]));
  scanPageAlignedImage.mockReturnValue(multiple.map(seal => ({ seal })));
  expect(decodePhoto(image, { returnPayload: true })).toEqual({ status: "found-multiple", texts: multiple });
});

it("uses measured QR corners before the full-resolution and layout retries", async () => {
  scanRectifiedSeal.mockReturnValue({ seal: single });
  const action = decodePhoto(image, { returnPayload: true });
  expect(action).toEqual({ status: "found", text: single });
  expect(scanQrImage).not.toHaveBeenCalled();
  expect(scanWatermarkPreview).not.toHaveBeenCalled();
  expect(scanPageAlignedImage).not.toHaveBeenCalled();
  expect(scanRectifiedSeal).toHaveBeenCalledWith(image, {
    searchRadius: 12, shouldContinue: expect.any(Function),
  });
  expect((await verifyQRedSeals([action.text], publicKey)).status).toBe("VALID");
  expect((await verifyQRedSeals([action.text], "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI")).status).toBe("INVALID");
});

it("reserves time for a footer seal after the local alignment deadline", () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  scanRectifiedSeal.mockImplementation((_image, { shouldContinue }) => {
    expect(shouldContinue()).toBe(true);
    now = 4001;
    expect(shouldContinue()).toBe(false);
    return null;
  });
  scanQrImage.mockReturnValue(code(single));
  expect(decodePhoto(image, { returnPayload: true })).toEqual({ status: "found", text: single });
  expect(scanRectifiedSeal).toHaveBeenCalledTimes(1);
  expect(scanWatermarkPreview).toHaveBeenCalledTimes(1);
});

it("keeps the wider alignment search after quick, preview and footer misses", async () => {
  scanRectifiedSeal.mockReturnValueOnce(null).mockReturnValueOnce({ seal: single });
  const action = decodePhoto(image, { returnPayload: true });
  expect(action).toEqual({ status: "found", text: single });
  expect(scanRectifiedSeal).toHaveBeenCalledTimes(2);
  expect(scanRectifiedSeal).toHaveBeenLastCalledWith(image, { shouldContinue: expect.any(Function) });
  expect(scanQrImage.mock.invocationCallOrder[0]).toBeLessThan(scanRectifiedSeal.mock.invocationCallOrder[1]);
  expect(scanPageAlignedImage).not.toHaveBeenCalled();
  expect((await verifyQRedSeals([action.text], publicKey)).status).toBe("VALID");
});

it.each(["local", "preview", "wide"])("stops at the shared deadline and retains a chunk from %s", stage => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const expired = value => { now = 8001; return value; };
  if (stage === "local") scanRectifiedSeal.mockImplementation(() => expired({ seal: multiple[1] }));
  if (stage === "preview") scanWatermarkPreview.mockImplementation(() => expired(code(multiple[1])));
  if (stage === "wide") scanRectifiedSeal.mockReturnValueOnce(null)
    .mockImplementationOnce(() => expired({ seal: multiple[1] }));
  expect(decodePhoto(image, { returnPayload: true })).toEqual({ status: "found-multiple", texts: [multiple[1]] });
  expect(scanRectifiedSeal).toHaveBeenCalledTimes(stage === "wide" ? 2 : 1);
  expect(scanQrImage).toHaveBeenCalledTimes(stage === "wide" ? 1 : 0);
  expect(scanPageAlignedImage).not.toHaveBeenCalled();
});

it("returns retake guidance when the deadline expires without a payload", () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  scanRectifiedSeal.mockImplementation(() => { now = 8001; return null; });
  expect(decodePhoto(image, { returnPayload: true })).toMatchObject({ status: "feedback" });
  expect(scanWatermarkPreview).not.toHaveBeenCalled();
  expect(scanQrImage).not.toHaveBeenCalled();
});
