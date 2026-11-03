import { afterAll, beforeEach, expect, it, vi } from "vitest";

const scan = vi.hoisted(() => ({ quality: vi.fn(), frame: vi.fn(), action: vi.fn(), photo: vi.fn(), seal: vi.fn() }));
vi.mock("./pageCaptureQuality.js", () => ({ createPageCaptureGate: () => ({ update: scan.quality }) }));
vi.mock("./scanQrImage.js", () => ({ createQrFrameScanner: () => scan.frame }));
vi.mock("./decodePhoto.js", () => ({ qrFrameAction: scan.action, decodePhoto: scan.photo }));
vi.mock("../qredVerifier.js", () => ({ decodeSeal: scan.seal }));
vi.mock("../verifier/photoReadingPixels.js", () => ({ preparePhotoReadingPixels: vi.fn() }));
const scope = { postMessage: vi.fn() };
vi.stubGlobal("self", scope);
await import("./photoScan.worker.js");
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.clearAllMocks();
  scan.quality.mockReturnValue({ ready: true, state: "ready" });
  scan.action.mockReturnValue({ status: "continue" });
  scan.seal.mockReturnValue(null);
});
const image = { data: new Uint8ClampedArray(24), width: 2, height: 3 };
const capture = () => scope.onmessage({ data: { image, live: true, requirePageQuality: true, returnPayload: true } });

it("announces capture before any seal work and recovers from that same image", () => {
  scan.photo.mockImplementation(() => {
    expect(scope.postMessage).toHaveBeenCalledWith({ captured: true, quality: { ready: true, state: "ready" } });
    return { status: "found", text: "recovered seal" };
  });
  capture();
  expect(scan.frame).not.toHaveBeenCalled();
  expect(scan.photo).toHaveBeenCalledWith(image, { returnPayload: true });
  expect(scope.postMessage).toHaveBeenLastCalledWith({ action: { status: "found", text: "recovered seal" }, quality: { ready: true, state: "ready" } });
});

it("retains multipart recovery after an early capture acknowledgement", () => {
  scan.action.mockReturnValue({ status: "found", text: "first chunk" });
  scan.seal.mockReturnValue({ total_chunks: 2 });
  scan.photo.mockReturnValue({ status: "found-multiple", texts: ["first chunk", "second chunk"] });
  capture();
  expect(scan.photo).toHaveBeenCalledWith(image, { returnPayload: true });
  expect(scope.postMessage.mock.calls.at(-1)[0].action.texts).toHaveLength(2);
});

it("ends an unsuccessful captured-photo read with retake guidance", () => {
  scan.photo.mockReturnValue({ status: "continue" });
  capture();
  expect(scope.postMessage.mock.calls.at(-1)[0].action).toMatchObject({
    status: "feedback", message: expect.stringContaining("could not be read"),
  });
});

it("does not announce capture or run recovery for an unsteady frame", () => {
  scan.quality.mockReturnValueOnce({ ready: false, state: "hold" });
  capture();
  expect(scope.postMessage).toHaveBeenCalledTimes(1);
  expect(scope.postMessage.mock.calls[0][0].captured).toBeUndefined();
  expect(scan.frame).not.toHaveBeenCalled();
  expect(scan.photo).not.toHaveBeenCalled();
});
