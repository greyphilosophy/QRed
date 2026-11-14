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
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

it("stops exactly once and releases a late alternate lens after closing during a flashlight search", async () => {
  const grant = deferred(), initial = makeStream(), late = makeStream();
  const track = { getSettings: () => ({ deviceId: "first" }), getCapabilities: () => ({ torch: false }) };
  initial.getVideoTracks = () => [track];
  const mediaDevices = {
    enumerateDevices: async () => [{ kind: "videoinput", deviceId: "second", label: "Back Camera" }],
    getUserMedia: vi.fn(() => grant.promise),
  };
  vi.stubGlobal("navigator", { mediaDevices });
  const button = Object.assign(new EventTarget(), {
    ownerDocument: { getElementById: () => null }, setAttribute() {}, getAttribute: () => null,
  });
  const { camera, video, onError } = setup({ requestStream: async () => initial, lightButton: button });
  await flush();
  button.dispatchEvent(new Event("click"));
  await vi.waitFor(() => expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1));
  expect(initial.stop).toHaveBeenCalledTimes(1);
  camera.stop();
  grant.resolve(late); await flush();
  expect(late.stop).toHaveBeenCalledTimes(1);
  expect(video.srcObject).toBeNull();
  expect(button.hidden).toBe(true);
  expect(onError).not.toHaveBeenCalled();
});

it("plays and scans while camera controls are pending and leaves a replacement session untouched", async () => {
  const controls = deferred();
  const first = setup({ prepareStream: () => controls.promise });
  await flush();
  expect(first.video.srcObject).toBe(first.stream);
  expect(first.video.play).toHaveBeenCalledTimes(1);
  expect(first.onFrame).toHaveBeenCalledTimes(1);
  first.camera.stop();
  const second = setup({ video: first.video });
  await flush();
  controls.resolve();
  await flush();
  expect(first.stream.stop).toHaveBeenCalledTimes(1);
  expect(first.video.srcObject).toBe(second.stream);
  expect(first.onFrame).toHaveBeenCalledTimes(1);
  second.camera.stop(); second.camera.stop();
  expect(second.stream.stop).toHaveBeenCalledTimes(1);
  expect(first.video.srcObject).toBeNull();
});

it("releases a hidden tab's stream and reopens only while the scanner is still open", async () => {
  const page = Object.assign(new EventTarget(), { hidden: true });
  vi.stubGlobal("document", page);
  const first = makeStream(), second = makeStream();
  const requestStream = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const test = setup({ requestStream });
  function hide(hidden) {
    page.hidden = hidden;
    page.dispatchEvent(new Event("visibilitychange"));
  }
  expect(requestStream).not.toHaveBeenCalled();
  hide(false); hide(false);
  await flush();
  expect(test.video.srcObject).toBe(first);
  hide(true);
  expect(first.stop).toHaveBeenCalledTimes(1);
  expect(test.video.srcObject).toBeNull();
  hide(false);
  await flush();
  expect(test.video.srcObject).toBe(second);
  test.camera.stop();
  hide(true); hide(false);
  expect(second.stop).toHaveBeenCalledTimes(1);
  expect(requestStream).toHaveBeenCalledTimes(2);
});

it("ignores a stale grant after switching back to a newer preview", async () => {
  const page = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("document", page);
  const oldGrant = deferred(), old = makeStream(), current = makeStream();
  const test = setup({ requestStream: vi.fn().mockReturnValueOnce(oldGrant.promise).mockResolvedValueOnce(current) });
  page.hidden = true; page.dispatchEvent(new Event("visibilitychange"));
  page.hidden = false; page.dispatchEvent(new Event("visibilitychange"));
  await flush();
  oldGrant.resolve(old);
  await flush();
  expect(old.stop).toHaveBeenCalledTimes(1);
  expect(test.video.srcObject).toBe(current);
  expect(current.stop).not.toHaveBeenCalled();
  expect(test.onError).not.toHaveBeenCalled();
  test.camera.stop();
});

it("reports a stuck permission request and releases a grant arriving after the timeout", async () => {
  vi.useFakeTimers();
  const pending = deferred();
  const test = setup({ requestStream: () => pending.promise });
  await vi.advanceTimersToNextTimerAsync();
  expect(test.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/permission/i) }), "access");
  pending.resolve(test.stream);
  await flush();
  expect(test.stream.stop).toHaveBeenCalledTimes(1);
  expect(test.video.play).not.toHaveBeenCalled();
});

it("releases the camera if playback never delivers its first frame", async () => {
  vi.useFakeTimers();
  const test = setup({ waitForMetadata: true, video: { readyState: 0, play: () => new Promise(() => {}) } });
  await flush();
  await vi.advanceTimersToNextTimerAsync();
  expect(test.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/did not deliver a preview/) }), "play");
  expect(test.stream.stop).toHaveBeenCalledTimes(1);
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
