import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { canCaptureCameraPhoto, captureCameraPhoto } from "./cameraPhoto.js";

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
