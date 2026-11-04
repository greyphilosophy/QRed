import { afterAll, beforeEach, expect, it, vi } from "vitest";

const scan = vi.hoisted(() => ({ quality: vi.fn(), frame: vi.fn(), action: vi.fn(), photo: vi.fn(), seal: vi.fn() }));
vi.mock("./pageCaptureQuality.js", () => ({ createPageCaptureGate: () => ({ update: scan.quality }) }));
vi.mock("./scanQrImage.js", () => ({ createQrFrameScanner: () => scan.frame }));
vi.mock("./decodePhoto.js", () => ({ qrFrameAction: scan.action }));
vi.mock("./decodePhotoWithErasure.js", () => ({ decodePhotoWithErasure: scan.photo }));
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

it("announces capture before any seal work and recovers from that same image", async () => {
  scan.photo.mockImplementation(() => {
    expect(scope.postMessage).toHaveBeenCalledWith({ captured: true, quality: { ready: true, state: "ready" } });
    return { status: "found", text: "recovered seal" };
  });
  await capture();
  expect(scan.frame).not.toHaveBeenCalled();
  expect(scan.photo).toHaveBeenCalledWith(image, { returnPayload: true });
  expect(scope.postMessage).toHaveBeenLastCalledWith({ action: { status: "found", text: "recovered seal" }, quality: { ready: true, state: "ready" } });
});

it("retains multipart recovery after an early capture acknowledgement", async () => {
  scan.action.mockReturnValue({ status: "found", text: "first chunk" });
  scan.seal.mockReturnValue({ total_chunks: 2 });
  scan.photo.mockReturnValue({ status: "found-multiple", texts: ["first chunk", "second chunk"] });
  await capture();
  expect(scan.photo).toHaveBeenCalledWith(image, { returnPayload: true });
  expect(scope.postMessage.mock.calls.at(-1)[0].action.texts).toHaveLength(2);
});

it("ends an unsuccessful captured-photo read with retake guidance", async () => {
  scan.photo.mockReturnValue({ status: "continue" });
  await capture();
  expect(scope.postMessage.mock.calls.at(-1)[0].action).toMatchObject({
    status: "feedback", message: expect.stringContaining("could not be read"),
  });
});

it("does not announce capture or run recovery for an unsteady frame", async () => {
  scan.quality.mockReturnValueOnce({ ready: false, state: "hold" });
  await capture();
  expect(scope.postMessage).toHaveBeenCalledTimes(1);
  expect(scope.postMessage.mock.calls[0][0].captured).toBeUndefined();
  expect(scan.frame).not.toHaveBeenCalled();
  expect(scan.photo).not.toHaveBeenCalled();
});

it("hands off a native capture without spending time decoding the preview", () => {
  scope.onmessage({ data: { image, live: true, requirePageQuality: true, captureOnly: true } });
  expect(scope.postMessage).toHaveBeenCalledTimes(1);
  expect(scope.postMessage).toHaveBeenCalledWith({ captured: true, captureOnly: true, quality: { ready: true, state: "ready" } });
  expect(scan.photo).not.toHaveBeenCalled();
  expect(scan.frame).not.toHaveBeenCalled();
});

it("awaits asynchronous capture recovery without posting a Promise or releasing the frame early", async () => {
  let finish;
  scan.photo.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const pending = capture();
  expect(scope.postMessage).toHaveBeenCalledTimes(1);
  expect(scope.postMessage.mock.calls[0][0]).toMatchObject({ captured: true });
  const action = { status: "found-multiple", texts: ["shard 1", "shard 2"] };
  finish(action);
  await pending;
  expect(scope.postMessage).toHaveBeenCalledTimes(2);
  expect(scope.postMessage).toHaveBeenLastCalledWith({ action, quality: { ready: true, state: "ready" } });
});

it("awaits a chosen photo and reports asynchronous decoder failures", async () => {
  scan.photo.mockRejectedValue(new Error("Scan failed"));
  await scope.onmessage({ data: { image, returnPayload: true } });
  expect(scope.postMessage).toHaveBeenCalledTimes(1);
  expect(scope.postMessage).toHaveBeenCalledWith({ error: "Scan failed" });
});

it("keeps ordinary live previews on the synchronous frame decoder", async () => {
  const code = { data: "ordinary QR" };
  scan.frame.mockReturnValue(code);
  await scope.onmessage({ data: { image, live: true } });
  expect(scan.photo).not.toHaveBeenCalled();
  expect(scan.action).toHaveBeenCalledWith(image, code, { returnPayload: undefined });
  expect(scope.postMessage).toHaveBeenCalledTimes(1);
  expect(scope.postMessage).toHaveBeenCalledWith({ action: { status: "continue" } });
});
