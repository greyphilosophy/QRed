import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createQRedSeals } from "../qredSealer.js";
import { createQRedQrData } from "../qredQr.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { decodePhoto } from "./decodePhoto.js";
import { PHOTO_SCAN_BUDGET_MS } from "./photoScanBudget.js";
import { scanQrImage, scanWatermarkPreview } from "./scanQrImage.js";
import { scanPageAlignedImage } from "./pageAlignedScan.js";
import { scanFooterSeals } from "./footerSealScan.js";
import { scanRectifiedSeal, createRectifiedSealScanner, scanCurvedPageSeal } from "./rectifiedSealScan.js";

vi.mock("./scanQrImage.js", () => ({ scanQrImage: vi.fn(), scanWatermarkPreview: vi.fn() }));
vi.mock("./pageAlignedScan.js", () => ({ scanPageAlignedImage: vi.fn() }));
vi.mock("./footerSealScan.js", () => ({ scanFooterSeals: vi.fn() }));
vi.mock("./rectifiedSealScan.js", () => ({
  scanRectifiedSeal: vi.fn(), createRectifiedSealScanner: vi.fn(), scanCurvedPageSeal: vi.fn(),
}));
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
  createRectifiedSealScanner.mockReset().mockImplementation(image => options => scanRectifiedSeal(image, options));
  scanFooterSeals.mockReset().mockReturnValue([]);
  scanWatermarkPreview.mockReset().mockReturnValue(null);
  scanPageAlignedImage.mockReset().mockReturnValue([]);
  scanRectifiedSeal.mockReset().mockReturnValue(null);
  scanCurvedPageSeal.mockReset().mockReturnValue(null);
  scanQrImage.mockReset().mockReturnValue(null);
});

it("returns a curved-page seal before entering the wider and general searches", async () => {
  scanCurvedPageSeal.mockReturnValue({ seal: single });
  expect(decodePhoto(image, { returnPayload: true })).toEqual({ status: "found", text: single });
  expect(scanRectifiedSeal).toHaveBeenCalledTimes(1);
  expect(scanQrImage).toHaveBeenCalledTimes(1);
  expect(scanPageAlignedImage).not.toHaveBeenCalled();
  await expect(verifyQRedSeals([single], publicKey)).resolves.toMatchObject({ signature_valid: true });
});

it("ends the curved-page pass in time for other recovery methods", () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  scanCurvedPageSeal.mockImplementation((_image, { shouldContinue }) => {
    expect(shouldContinue()).toBe(true);
    now = 100;
    expect(shouldContinue()).toBe(false);
    return null;
  });
  decodePhoto(image, { returnPayload: true, maxDurationMs: 300 });
  expect(scanCurvedPageSeal).toHaveBeenCalledOnce();
  expect(scanPageAlignedImage).toHaveBeenCalledOnce();
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
  expect(scanPageAlignedImage).toHaveBeenCalledWith(image, { deep: true, shouldContinue: expect.any(Function), onSeal: expect.any(Function) });
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
    { tryRescaling: false, tryWatermark: false, maxAttempts: 2, maxScanPixels: 1_500_000, fastResize: true,
      shouldContinue: expect.any(Function) });
  expect((await verifyQRedSeals([action.text], publicKey)).status).toBe("VALID");
});

it("does not let a single footer chunk skip collection of the remaining chunks", () => {
  scanQrImage.mockReturnValue(code(multiple[0]));
  scanPageAlignedImage.mockReturnValue(multiple.map(seal => ({ seal })));
  expect(decodePhoto(image, { returnPayload: true })).toEqual({ status: "found-multiple", texts: multiple });
});

it("recovers a seal from measured QR corners even when the read takes nine seconds", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  scanRectifiedSeal.mockImplementation((_image, { shouldContinue }) => {
    now = 9000;
    return shouldContinue() ? { seal: single } : null;
  });
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
    now = PHOTO_SCAN_BUDGET_MS / 2 + 1;
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
  expect(createRectifiedSealScanner).toHaveBeenCalledTimes(1);
  expect(createRectifiedSealScanner).toHaveBeenCalledWith(image);
  expect(scanRectifiedSeal).toHaveBeenLastCalledWith(image, { shouldContinue: expect.any(Function) });
  expect(scanQrImage.mock.invocationCallOrder[0]).toBeLessThan(scanRectifiedSeal.mock.invocationCallOrder[1]);
  expect(scanPageAlignedImage).not.toHaveBeenCalled();
  expect((await verifyQRedSeals([action.text], publicKey)).status).toBe("VALID");
});

it("never shares rectified preparation between separate photo requests", () => {
  decodePhoto(image, { returnPayload: true });
  decodePhoto(image, { returnPayload: true });
  expect(createRectifiedSealScanner).toHaveBeenCalledTimes(2);
});

it.each(["local", "preview", "wide", "footer"])("stops at the shared deadline and retains a chunk from %s", stage => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const expired = value => { now = PHOTO_SCAN_BUDGET_MS + 1; return value; };
  if (stage === "local") scanRectifiedSeal.mockImplementation(() => expired({ seal: multiple[1] }));
  if (stage === "preview") scanWatermarkPreview.mockImplementation(() => expired(code(multiple[1])));
  if (stage === "footer") scanFooterSeals.mockImplementation(() => expired([code(multiple[1])]));
  if (stage === "wide") scanRectifiedSeal.mockReturnValueOnce(null)
    .mockImplementationOnce(() => expired({ seal: multiple[1] }));
  expect(decodePhoto(image, { returnPayload: true })).toEqual({ status: "found-multiple", texts: [multiple[1]] });
  expect(scanRectifiedSeal).toHaveBeenCalledTimes(stage === "wide" ? 2 : 1);
  expect(scanQrImage).toHaveBeenCalledTimes(["wide", "footer"].includes(stage) ? 1 : 0);
  expect(scanPageAlignedImage).not.toHaveBeenCalled();
});

it("returns retake guidance when the deadline expires without a payload", () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  scanRectifiedSeal.mockImplementation(() => { now = PHOTO_SCAN_BUDGET_MS + 1; return null; });
  expect(decodePhoto(image, { returnPayload: true })).toMatchObject({ status: "feedback" });
  expect(scanWatermarkPreview).not.toHaveBeenCalled();
  expect(scanQrImage).not.toHaveBeenCalled();
});

it("returns a complete isolated footer group for normal signature verification", async () => {
  scanFooterSeals.mockReturnValue(multiple.map(code));
  const action = decodePhoto(image, { returnPayload: true });
  expect(action).toEqual({ status: "found-multiple", texts: multiple });
  expect(scanPageAlignedImage).not.toHaveBeenCalled();
  expect((await verifyQRedSeals(action.texts, publicKey)).status).toBe("VALID");
  expect((await verifyQRedSeals(action.texts, "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI")).status).toBe("INVALID");
});

it("does not stop on incomplete or duplicated isolated footer chunks", () => {
  scanFooterSeals.mockReturnValue([code(multiple[0]), code(multiple[0])]);
  scanPageAlignedImage.mockReturnValue(multiple.map(seal => ({ seal })));
  expect(decodePhoto(image, { returnPayload: true })).toEqual({ status: "found-multiple", texts: multiple });
  expect(scanPageAlignedImage).toHaveBeenCalled();
});

it("continues searching when an unrelated complete footer accompanies an incomplete group", () => {
  scanFooterSeals.mockReturnValue([code(single), code(multiple[0])]);
  scanPageAlignedImage.mockReturnValue(multiple.map(seal => ({ seal })));
  expect(decodePhoto(image, { returnPayload: true })).toEqual({ status: "found-multiple", texts: [...multiple, single] });
  expect(scanPageAlignedImage).toHaveBeenCalled();
});

it("checkpoints only newly decoded chunks before slower fallback work", async () => {
  const onProgress = vi.fn();
  scanRectifiedSeal.mockReturnValueOnce({ seal: multiple[0] }).mockReturnValue(null);
  scanWatermarkPreview.mockReturnValue(code(multiple[0]));
  scanQrImage.mockReturnValue(code(multiple[1]));
  scanFooterSeals.mockImplementation(() => {
    expect(onProgress.mock.calls.map(([action]) => action.texts)).toEqual([[multiple[0]], [multiple[0], multiple[1]]]);
    return [];
  });
  decodePhoto(image, { returnPayload: true, onProgress });
  expect(onProgress).toHaveBeenCalledTimes(2);
  const checkpoint = onProgress.mock.calls[0][0];
  expect(checkpoint.texts).toEqual([multiple[0]]);
  // Checkpointing is collection, not signature verification.
  expect((await verifyQRedSeals([single], "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI")).status).toBe("INVALID");
});

it("does not report navigation or unrelated QR text as seal progress", () => {
  const onProgress = vi.fn();
  scanWatermarkPreview.mockReturnValue({ data: "https://qred.org" });
  scanQrImage.mockReturnValue({ data: "https://example.test" });
  decodePhoto(image, { returnPayload: true, onProgress });
  expect(onProgress).not.toHaveBeenCalled();
});

it.each(["footer", "alignment"])("checkpoints a chunk before the next %s attempt can block", stage => {
  const onProgress = vi.fn();
  const scanner = stage === "footer" ? scanFooterSeals : scanPageAlignedImage;
  scanner.mockImplementation((_image, { onSeal }) => {
    onSeal(multiple[0]);
    expect(onProgress).toHaveBeenCalledWith({ status: "found-multiple", texts: [multiple[0]] });
    // Simulate termination during the next attempt, before the helper returns.
    throw new Error("terminated during the next synchronous attempt");
  });
  expect(() => decodePhoto(image, { returnPayload: true, onProgress })).toThrow("terminated");
  expect(onProgress).toHaveBeenCalledTimes(1);
});

it("reports only fixed stage names and relative elapsed times before actual attempts", () => {
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const stages = [];
  const onStage = stage => stages.push(stage);
  scanRectifiedSeal.mockImplementation(() => { now += 100; return null; });
  scanWatermarkPreview.mockImplementation(() => { now += 20; return null; });
  scanQrImage.mockImplementation(() => { now += 30; return null; });
  scanFooterSeals.mockImplementation(() => { now += 40; return []; });
  scanPageAlignedImage.mockImplementation(() => { now += 50; return []; });
  decodePhoto(image, { returnPayload: true, onStage });
  expect(stages).toEqual([
    { stage: "rectified-fast", elapsedMs: 0 },
    { stage: "watermark-preview", elapsedMs: 100 },
    { stage: "ordinary-qr", elapsedMs: 120 },
    { stage: "footer", elapsedMs: 150 },
    { stage: "curved-page", elapsedMs: 190 },
    { stage: "rectified-wide", elapsedMs: 190 },
    { stage: "page-aligned", elapsedMs: 290 },
    { stage: "general-qr", elapsedMs: 340 },
  ]);
});

it("retains the last stage checkpoint when an attempt blocks and reports no skipped stages", () => {
  let now = 500;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const onStage = vi.fn();
  scanRectifiedSeal.mockImplementation(() => {
    expect(onStage).toHaveBeenLastCalledWith({ stage: "rectified-fast", elapsedMs: 0 });
    now += PHOTO_SCAN_BUDGET_MS + 1;
    return null;
  });
  decodePhoto(image, { returnPayload: true, onStage });
  expect(onStage).toHaveBeenCalledTimes(1);
  expect(scanWatermarkPreview).not.toHaveBeenCalled();
});

it("reports the direct QR stage for non-payload callers without exposing recovered content", () => {
  const onStage = vi.fn();
  scanQrImage.mockReturnValue(code(single));
  decodePhoto(image, { onStage });
  expect(onStage).toHaveBeenCalledTimes(1);
  expect(onStage).toHaveBeenCalledWith({ stage: "general-qr", elapsedMs: expect.any(Number) });
  expect(Object.keys(onStage.mock.calls[0][0]).sort()).toEqual(["elapsedMs", "stage"]);
});

it("timestamps the specific final fallback before the worker starts it", () => {
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  scanQrImage.mockImplementation((_data, _width, _height, { onStage }) => {
    now += 75;
    onStage("qr-filtered");
    return null;
  });
  const onStage = vi.fn();
  decodePhoto(image, { onStage });
  expect(onStage.mock.calls.flat()).toEqual([
    { stage: "general-qr", elapsedMs: 0 }, { stage: "qr-filtered", elapsedMs: 75 },
  ]);
});

it.each([[8000, 1300, 3300], [4000, 500, 1500]])(
  "leaves wider recovery reachable after the ordinary preflight allowance (%s ms overall)",
  (maxDurationMs, ordinaryStart, ordinaryEnd) => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    scanWatermarkPreview.mockImplementation(() => { now = ordinaryStart; return null; });
    scanQrImage.mockImplementation((_data, _width, _height, options) => {
      expect(options.maxScanPixels).toBe(1_500_000);
      expect(options.shouldContinue()).toBe(true);
      now = ordinaryEnd - 1;
      expect(options.shouldContinue()).toBe(true);
      now = ordinaryEnd;
      expect(options.shouldContinue()).toBe(false);
      return null;
    });
    scanFooterSeals.mockImplementation((_image, { shouldContinue }) => {
      expect(shouldContinue()).toBe(true); return [];
    });
    scanRectifiedSeal.mockReturnValueOnce(null).mockImplementationOnce((_image, { shouldContinue }) => {
      expect(shouldContinue()).toBe(true); return { seal: single };
    });
    expect(decodePhoto(image, { returnPayload: true, maxDurationMs })).toEqual({ status: "found", text: single });
    expect(scanRectifiedSeal).toHaveBeenCalledTimes(2);
    expect(scanQrImage).toHaveBeenCalledTimes(1);
  });

it("does not let the ordinary allowance extend the overall photo deadline", () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  scanWatermarkPreview.mockImplementation(() => { now = PHOTO_SCAN_BUDGET_MS - 1000; return null; });
  scanQrImage.mockImplementation((_data, _width, _height, { shouldContinue }) => {
    now = PHOTO_SCAN_BUDGET_MS - 1; expect(shouldContinue()).toBe(true);
    now = PHOTO_SCAN_BUDGET_MS; expect(shouldContinue()).toBe(false);
    return null;
  });
  expect(decodePhoto(image, { returnPayload: true }).status).toBe("feedback");
  expect(scanFooterSeals).not.toHaveBeenCalled();
  expect(scanRectifiedSeal).toHaveBeenCalledTimes(1);
});
