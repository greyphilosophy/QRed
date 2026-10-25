import { afterEach, expect, it, vi } from "vitest";
import { startCameraSession } from "./cameraSession.js";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const makeStream = () => { const stop = vi.fn(); return { getTracks: () => [{ stop }], stop }; };
function setup(options = {}) {
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const video = { srcObject: null, play: vi.fn().mockResolvedValue(), readyState: 2 };
  const stream = makeStream(), onFrame = vi.fn(), onError = vi.fn();
  const camera = startCameraSession({ video, requestStream: async () => stream, onFrame, onError, ...options });
  return { camera, video, stream, onFrame, onError };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("releases a delayed camera grant after stop without attaching it or restarting decoding", async () => {
  const pending = deferred();
  const test = setup({ requestStream: () => pending.promise });
  await flush();
  test.camera.stop();
  pending.resolve(test.stream);
  await flush();
  expect(test.stream.stop).toHaveBeenCalledTimes(1);
  expect(test.video.srcObject).toBeNull();
  expect(test.video.play).not.toHaveBeenCalled();
  expect(test.onFrame).not.toHaveBeenCalled();
});

it("stops while camera controls are pending and leaves a replacement session untouched", async () => {
  const controls = deferred();
  const first = setup({ prepareStream: () => controls.promise });
  await flush();
  first.camera.stop();
  const second = setup({ video: first.video });
  await flush();
  controls.resolve();
  await flush();
  expect(first.stream.stop).toHaveBeenCalledTimes(1);
  expect(first.video.srcObject).toBe(second.stream);
  expect(first.onFrame).not.toHaveBeenCalled();
  second.camera.stop(); second.camera.stop();
  expect(second.stream.stop).toHaveBeenCalledTimes(1);
  expect(first.video.srcObject).toBeNull();
});

it("releases tracks and scheduled decoding if video playback fails", async () => {
  const playing = Promise.reject(new Error("Playback blocked"));
  const video = { srcObject: null, play: () => playing, readyState: 2 };
  const test = setup({ video });
  await flush();
  expect(test.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Playback blocked" }), "play");
  expect(test.stream.stop).toHaveBeenCalledTimes(1);
  expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  expect(video.srcObject).toBeNull();
});

it("starts cooldown at decode completion and cancels metadata/frame callbacks on stop", async () => {
  let now = 0, tick;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const onFrame = vi.fn(() => { now += 300; });
  const test = setup({ onFrame, waitForMetadata: true });
  requestAnimationFrame.mockImplementation(callback => { tick = callback; return 7; });
  await flush();
  expect(onFrame).toHaveBeenCalledTimes(1);
  now = 424; tick();
  expect(onFrame).toHaveBeenCalledTimes(1);
  now = 425; tick();
  expect(onFrame).toHaveBeenCalledTimes(2);
  const metadata = test.video.onloadedmetadata;
  test.camera.stop(); tick(); metadata();
  expect(onFrame).toHaveBeenCalledTimes(2);
  expect(test.video.onloadedmetadata).toBeNull();
  expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
});
