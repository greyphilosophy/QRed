import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { canCaptureCameraPhoto, captureCameraPhoto, cameraCaptureFeedback, cameraFrameDiagnostic } from "./cameraPhoto.js";

const track = { kind: "video", readyState: "live" };
const video = { srcObject: { getVideoTracks: () => [track] } };
let camera, bitmap, canvas, context, pixels;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
beforeEach(() => {
  pixels = { width: 4000, height: 3000, data: new Uint8ClampedArray(4) };
  context = { drawImage: vi.fn(), getImageData: vi.fn(() => pixels) };
  canvas = { width: 640, height: 480, getContext: () => context };
  bitmap = { width: 4000, height: 3000, close: vi.fn() };
  camera = { getPhotoCapabilities: vi.fn().mockResolvedValue({
    imageWidth: { min: 640, max: 4000 }, imageHeight: { min: 480, max: 3000 },
  }), takePhoto: vi.fn().mockResolvedValue(new Blob()) };
  vi.stubGlobal("ImageCapture", vi.fn(function() { return camera; }));
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("uses still-photo detail with flash off and retains exactly the pixels sent to decoding", async () => {
  expect(canCaptureCameraPhoto(video)).toBe(true);
  expect(await captureCameraPhoto(video, canvas)).toBe(pixels);
  expect(ImageCapture).toHaveBeenCalledWith(track);
  expect(camera.takePhoto).toHaveBeenCalledWith({ fillLightMode: "off", imageWidth: 4000, imageHeight: 3000 });
  expect(canvas).toMatchObject({ width: 4000, height: 3000 });
  expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 4000, 3000);
  expect(bitmap.close).toHaveBeenCalledTimes(1);
});

it.each(["unsupported", "rejected", "smaller"])("retains the frozen preview when still capture is %s", async kind => {
  if (kind === "unsupported") vi.stubGlobal("ImageCapture", undefined);
  if (kind === "rejected") camera.takePhoto.mockRejectedValue(new Error("unsupported source"));
  if (kind === "smaller") { bitmap.width = 320; bitmap.height = 240; }
  expect(await captureCameraPhoto(video, canvas)).toBeNull();
  expect(canvas).toMatchObject({ width: 640, height: 480 });
  expect(context.drawImage).not.toHaveBeenCalled();
});

it("times out a slow still capture and never overwrites the fallback with its late result", async () => {
  vi.useFakeTimers();
  let finish;
  camera.takePhoto.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const result = captureCameraPhoto(video, canvas);
  await flush();
  await vi.advanceTimersByTimeAsync(1800);
  expect(await result).toBeNull();
  finish(new Blob()); await flush();
  expect(createImageBitmap).not.toHaveBeenCalled();
  expect(context.drawImage).not.toHaveBeenCalled();
});

it("closes a late decoded bitmap after cancellation without changing the retained frame", async () => {
  let finish;
  createImageBitmap.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const result = captureCameraPhoto(video, canvas, { signal: controller.signal });
  await flush();
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  finish(bitmap); await flush();
  expect(bitmap.close).toHaveBeenCalledTimes(1);
  expect(context.drawImage).not.toHaveBeenCalled();
});

it("does not reuse old decoding pixels if replacing the retained photo fails", async () => {
  context.drawImage.mockImplementation(() => { throw new Error("Drawing failed"); });
  await expect(captureCameraPhoto(video, canvas)).rejects.toThrow("Drawing failed");
  expect(bitmap.close).toHaveBeenCalledTimes(1);
});

it.each(["missing", "unsupported"])("takes a native still when optional capability discovery is %s", async kind => {
  if (kind === "missing") delete camera.getPhotoCapabilities;
  else camera.getPhotoCapabilities.mockRejectedValue(new DOMException("not implemented", "NotSupportedError"));
  const onDiagnostic = vi.fn();
  expect(await captureCameraPhoto(video, canvas, { onDiagnostic })).toBe(pixels);
  expect(camera.takePhoto).toHaveBeenCalledWith({ fillLightMode: "off" });
  expect(onDiagnostic).toHaveBeenCalledWith({ source: "native-still", width: 4000, height: 3000, reason: "captured" });
});

it.each(["NotSupportedError", "OverconstrainedError", "TypeError"])("retries rejected dimensions once after %s without enabling flash", async name => {
  camera.takePhoto.mockRejectedValueOnce(new DOMException("invalid dimensions", name));
  expect(await captureCameraPhoto(video, canvas)).toBe(pixels);
  expect(camera.takePhoto.mock.calls).toEqual([
    [{ fillLightMode: "off", imageWidth: 4000, imageHeight: 3000 }], [{ fillLightMode: "off" }],
  ]);
});

it.each(["NotAllowedError", "SecurityError", "OperationError"])("does not retry a permission or camera failure: %s", async name => {
  camera.takePhoto.mockRejectedValue(new DOMException("private device message", name));
  const onDiagnostic = vi.fn();
  expect(await captureCameraPhoto(video, canvas, { onDiagnostic })).toBeNull();
  expect(camera.takePhoto).toHaveBeenCalledTimes(1);
  expect(onDiagnostic).toHaveBeenCalledWith({ source: "video-frame", width: 640, height: 480, reason: "capture-failed" });
  expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain("private device message");
});

it("does not take a still after denied capability access", async () => {
  camera.getPhotoCapabilities.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
  expect(await captureCameraPhoto(video, canvas)).toBeNull();
  expect(camera.takePhoto).not.toHaveBeenCalled();
});

it("shares one deadline across capability discovery, sizing retry and bitmap decode", async () => {
  vi.useFakeTimers();
  let capabilities, rejectSized, finishRetry;
  camera.getPhotoCapabilities.mockImplementation(() => new Promise(resolve => { capabilities = resolve; }));
  camera.takePhoto.mockImplementationOnce(() => new Promise((_, reject) => { rejectSized = reject; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishRetry = resolve; }));
  const onDiagnostic = vi.fn(), result = captureCameraPhoto(video, canvas, { onDiagnostic });
  await vi.advanceTimersByTimeAsync(800);
  capabilities({ imageWidth: { max: 4000 }, imageHeight: { max: 3000 } }); await flush();
  await vi.advanceTimersByTimeAsync(700);
  rejectSized(new DOMException("bad dimensions", "NotSupportedError")); await flush();
  await vi.advanceTimersByTimeAsync(299);
  expect(onDiagnostic).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBeNull();
  expect(onDiagnostic).toHaveBeenCalledWith({ source: "video-frame", width: 640, height: 480, reason: "timeout" });
  finishRetry(new Blob()); await flush();
  expect(createImageBitmap).not.toHaveBeenCalled();
  expect(context.drawImage).not.toHaveBeenCalled();
  expect(onDiagnostic).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not start a sizing retry after cancellation or capability timeout", async () => {
  vi.useFakeTimers();
  let finish;
  camera.getPhotoCapabilities.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const onDiagnostic = vi.fn(), result = captureCameraPhoto(video, canvas, { onDiagnostic });
  await vi.advanceTimersByTimeAsync(1800);
  expect(await result).toBeNull();
  finish({ imageWidth: { max: 4000 }, imageHeight: { max: 3000 } }); await flush();
  expect(camera.takePhoto).not.toHaveBeenCalled();
  expect(onDiagnostic).toHaveBeenCalledTimes(1);
});

it("does not emit diagnostics or begin a fallback attempt after cancellation", async () => {
  let reject;
  camera.takePhoto.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  const controller = new AbortController(), onDiagnostic = vi.fn();
  const result = captureCameraPhoto(video, canvas, { signal: controller.signal, onDiagnostic });
  await flush(); controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  reject(new DOMException("bad dimensions", "NotSupportedError")); await flush();
  expect(camera.takePhoto).toHaveBeenCalledTimes(1);
  expect(onDiagnostic).not.toHaveBeenCalled();
});

it("adds only whitelisted capture metadata to failures, retaining recovered partial seals", () => {
  const action = { status: "found-multiple", texts: ["partial"], timedOut: true, message: "Try again." };
  const capture = { ...cameraFrameDiagnostic({ width: 1920, height: 1080 }, "timeout"), deviceId: "private", data: "private pixels" };
  expect(cameraCaptureFeedback(action, capture)).toEqual({ ...action,
    message: "Try again. Camera frame: 1920 × 1080. Still photo capture timed out." });
  expect(action.message).toBe("Try again.");
  expect(cameraCaptureFeedback({ status: "found", text: "ok" }, capture)).toEqual({ status: "found", text: "ok" });
  expect(cameraCaptureFeedback({ status: "feedback", message: "No seal." }, { source: "native-still", width: 4000, height: 3000 }))
    .toMatchObject({ message: "No seal. Camera photo: 4000 × 3000." });
  expect(cameraCaptureFeedback(action, { width: 0, height: 0 })).toBe(action);
});
