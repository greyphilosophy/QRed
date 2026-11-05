import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { canCaptureCameraPhoto, captureCameraPhoto, cameraCaptureFeedback, cameraFrameDiagnostic, cameraPhotoFailure, readCameraPhotoFile, NATIVE_PHOTO_TIMEOUT_MS, cameraCaptureContext } from "./cameraPhoto.js";

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
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
  const result = captureCameraPhoto(video, canvas, { timeoutMs: 1800 });
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
  expect(onDiagnostic).toHaveBeenCalledWith({ source: "native-still", width: 4000, height: 3000, sourceWidth: 4000, sourceHeight: 3000, preparationMs: expect.any(Number), reason: "captured" });
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
  const onDiagnostic = vi.fn(), result = captureCameraPhoto(video, canvas, { onDiagnostic, timeoutMs: 1800 });
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
  const onDiagnostic = vi.fn(), result = captureCameraPhoto(video, canvas, { onDiagnostic, timeoutMs: 1800 });
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

it("allows a genuine still to finish after the old 1.8-second preview fallback deadline", async () => {
  vi.useFakeTimers();
  camera.takePhoto.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(new Blob()), 2200)));
  const onDiagnostic = vi.fn(), result = captureCameraPhoto(video, canvas, { onDiagnostic, requireHighResolution: true });
  await vi.advanceTimersByTimeAsync(1800);
  expect(onDiagnostic).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(400);
  expect(await result).toBe(pixels);
  expect(onDiagnostic).toHaveBeenCalledWith({ source: "native-still", width: 4000, height: 3000, sourceWidth: 4000, sourceHeight: 3000, preparationMs: expect.any(Number), reason: "captured" });
  expect(NATIVE_PHOTO_TIMEOUT_MS).toBe(5000);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([[1920, 1080, false], [2560, 1440, false], [2560, 1920, true], [3000, 4000, true]])(
  "checks actual native photo dimensions %i×%i, not the requested or preview size", async (width, height, usable) => {
    bitmap.width = width; bitmap.height = height;
    const onDiagnostic = vi.fn();
    const image = await captureCameraPhoto(video, canvas, { requireHighResolution: true, onDiagnostic });
    expect(image).toBe(usable ? pixels : null);
    expect(context.drawImage).toHaveBeenCalledTimes(usable ? 1 : 0);
    if (!usable) {
      expect(onDiagnostic).toHaveBeenCalledWith({ source: "native-still", width, height, reason: "low-resolution" });
      expect(cameraPhotoFailure(onDiagnostic.mock.calls[0][0])).toMatchObject({ captureFailed: true, message: expect.stringContaining("No video frame was scanned") });
      expect(canvas).toMatchObject({ width: 640, height: 480 });
    }
  });

it("does not overlap uncancellable native requests after a timeout", async () => {
  vi.useFakeTimers();
  let finish;
  camera.takePhoto.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = captureCameraPhoto(video, canvas, { timeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(100); expect(await first).toBeNull();
  const onDiagnostic = vi.fn();
  expect(await captureCameraPhoto(video, canvas, { onDiagnostic })).toBeNull();
  expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ reason: "camera-busy" }));
  expect(camera.takePhoto).toHaveBeenCalledTimes(1);
  finish(new Blob()); await flush();
  expect(context.drawImage).not.toHaveBeenCalled();
  expect(await captureCameraPhoto(video, canvas)).toBe(pixels);
  expect(camera.takePhoto).toHaveBeenCalledTimes(2);
});

it("opens an explicitly selected high-resolution photo locally and reports its actual dimensions", async () => {
  const photo = { naturalWidth: 4000, naturalHeight: 3000, decode: vi.fn().mockResolvedValue(), src: "" };
  vi.stubGlobal("Image", vi.fn(function () { return photo; }));
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:selected"), revokeObjectURL: vi.fn() });
  const onDiagnostic = vi.fn();
  expect(await readCameraPhotoFile(new Blob(), canvas, { onDiagnostic })).toBe(pixels);
  expect(context.drawImage).toHaveBeenCalledWith(photo, 0, 0, 4000, 3000);
  expect(onDiagnostic).toHaveBeenCalledWith({ source: "selected-photo", width: 4000, height: 3000, sourceWidth: 4000, sourceHeight: 3000, preparationMs: expect.any(Number), reason: "captured" });
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:selected");
  expect(photo.src).toBe("");
});

it("rejects an undersized selected photo before replacing the preview", async () => {
  vi.stubGlobal("Image", vi.fn(function () { return { naturalWidth: 1920, naturalHeight: 1080, decode: () => Promise.resolve(), src: "" }; }));
  vi.stubGlobal("URL", { createObjectURL: () => "blob:small", revokeObjectURL: vi.fn() });
  const onDiagnostic = vi.fn();
  expect(await readCameraPhotoFile(new Blob(), canvas, { onDiagnostic })).toBeNull();
  expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ source: "selected-photo", reason: "low-resolution" }));
  expect(context.drawImage).not.toHaveBeenCalled();
});

it("cancels a pending selected photo without replacing pixels or publishing stale metadata", async () => {
  let finish;
  const photo = { naturalWidth: 4000, naturalHeight: 3000, decode: () => new Promise(resolve => { finish = resolve; }), src: "" };
  vi.stubGlobal("Image", vi.fn(function () { return photo; }));
  vi.stubGlobal("URL", { createObjectURL: () => "blob:cancel", revokeObjectURL: vi.fn() });
  const controller = new AbortController(), onDiagnostic = vi.fn();
  const result = readCameraPhotoFile(new Blob(), canvas, { signal: controller.signal, onDiagnostic });
  controller.abort(); await expect(result).rejects.toMatchObject({ name: "AbortError" });
  finish(); await flush();
  expect(context.drawImage).not.toHaveBeenCalled(); expect(onDiagnostic).not.toHaveBeenCalled();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:cancel");
});


it.each(["native", "selected"].flatMap(source => [
  [source, 5312, 2988], [source, 7680, 4320], [source, 2988, 5312], [source, 4032, 3024],
]))("keeps a %s %i×%i photo inside the native decoder's exact pixel cap", async (source, width, height) => {
  const onDiagnostic = vi.fn();
  context.getImageData.mockImplementation((_x, _y, w, h) => ({ ...pixels, width: w, height: h }));
  let image;
  if (source === "native") {
    bitmap.width = width; bitmap.height = height;
    image = await captureCameraPhoto(video, canvas, { requireHighResolution: true, onDiagnostic });
  } else {
    const photo = { naturalWidth: width, naturalHeight: height, decode: () => Promise.resolve(), src: "" };
    vi.stubGlobal("Image", vi.fn(function () { return photo; }));
    vi.stubGlobal("URL", { createObjectURL: () => "blob:large", revokeObjectURL: vi.fn() });
    image = await readCameraPhotoFile(new Blob(), canvas, { onDiagnostic });
  }
  const scale = Math.sqrt(12_000_000 / (width * height));
  const expectedWidth = Math.floor(width * scale), expectedHeight = Math.floor(height * scale);
  expect(image).toMatchObject({ width: expectedWidth, height: expectedHeight });
  expect(image.width * image.height).toBeLessThanOrEqual(12_000_000);
  expect(image.width * image.height).toBeGreaterThan(11_990_000);
  expect(canvas).toMatchObject({ width: image.width, height: image.height });
  expect(context.getImageData).toHaveBeenCalledWith(0, 0, image.width, image.height);
  expect(onDiagnostic).toHaveBeenCalledWith({ source: source === "native" ? "native-still" : "selected-photo",
    width: image.width, height: image.height, sourceWidth: width, sourceHeight: height, preparationMs: expect.any(Number), reason: "captured" });
});

it("reports source and working dimensions separately and measures preparation before decoding", async () => {
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  bitmap.width = 6000; bitmap.height = 8000;
  camera.takePhoto.mockImplementation(async () => { now = 850; return new Blob(); });
  context.getImageData.mockImplementation((_x, _y, width, height) => {
    now = 900;
    return { width, height, data: new Uint8ClampedArray(4) };
  });
  const onDiagnostic = vi.fn();
  await captureCameraPhoto(video, canvas, { onDiagnostic });
  expect(onDiagnostic).toHaveBeenCalledWith({ source: "native-still", width: 3000, height: 4000,
    sourceWidth: 6000, sourceHeight: 8000, preparationMs: 800, reason: "captured" });
  const action = { status: "feedback", message: "No seal." };
  expect(cameraCaptureFeedback(action, onDiagnostic.mock.calls[0][0]).message)
    .toBe("No seal. Camera photo: 3000 × 4000 (from 6000 × 8000, prepared in 0.8 s).");
});

it("ignores malformed extra capture metadata and never renders arbitrary fields", () => {
  const action = { status: "feedback", message: "No seal." };
  expect(cameraCaptureFeedback(action, { source: "native-still", width: 3000, height: 4000,
    sourceWidth: "private", sourceHeight: 8000, preparationMs: Infinity, deviceId: "private", text: "private" }).message)
    .toBe("No seal. Camera photo: 3000 × 4000.");
});

it("snapshots only preview dimensions, trigger and an allowlisted guide state", () => {
  const frame = { width: 640, height: 480, data: "private pixels" };
  const quality = { state: "small", message: "private message", samples: [1, 2] };
  const context = cameraCaptureContext(frame, false, quality);
  expect(context).toEqual({ trigger: "manual", previewWidth: 640, previewHeight: 480, guideState: "small" });
  frame.width = 3000; quality.state = "ready";
  const action = { status: "feedback", message: "No seal." };
  expect(cameraCaptureFeedback(action, { source: "native-still", width: 3000, height: 4000, ...context }).message)
    .toBe("No seal. Camera photo: 3000 × 4000. Before photo: manual capture, 640 × 480 preview, last guide: page too small.");
  expect(cameraCaptureContext({ width: 0, height: 1 }, true, { state: "private" }))
    .toEqual({ trigger: "automatic" });
});
