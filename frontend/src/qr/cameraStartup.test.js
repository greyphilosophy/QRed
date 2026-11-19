import { afterEach, expect, it, vi } from "vitest";
import { getPreferredCameraStream } from "./cameraControls.js";
import { forgetPreferredCamera, preferredCameraId } from "./cameraPreference.js";
import { inspectCameraCapabilities } from "./cameraInspection.js";

function camera(id, capabilities = {}) {
  const stop = vi.fn(), applyConstraints = vi.fn();
  const track = { stop, applyConstraints, getSettings: () => ({ deviceId: id, facingMode: "environment" }),
    getCapabilities: () => capabilities };
  return { getTracks: () => [track], getVideoTracks: () => [track], stop, applyConstraints };
}
const devices = ids => ids.map((deviceId, index) => ({ kind: "videoinput", deviceId, label: `camera2 ${index}, facing back` }));
afterEach(() => { forgetPreferredCamera(preferredCameraId()); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("selects a focusing, lit-capable rear lens on the first visit without lighting it or storing a preference", async () => {
  const first = camera("wide", { focusMode: ["none"], torch: false });
  const main = camera("focused", { focusMode: ["continuous"], torch: [false, true] });
  const reopened = camera("focused", { focusMode: ["continuous"], torch: true });
  const setItem = vi.fn();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem, removeItem() {} });
  const mediaDevices = {
    getUserMedia: vi.fn().mockResolvedValueOnce(first).mockImplementationOnce(() => {
      expect(first.stop).toHaveBeenCalledOnce();
      return main;
    }).mockResolvedValueOnce(reopened),
    enumerateDevices: vi.fn(async () => devices(["wide", "focused"])),
  };
  await expect(getPreferredCameraStream(mediaDevices)).resolves.toBe(main);
  expect(mediaDevices.getUserMedia.mock.calls[1][0].video.deviceId).toEqual({ exact: "focused" });
  expect(first.applyConstraints).not.toHaveBeenCalled();
  expect(main.applyConstraints).not.toHaveBeenCalled();
  expect(preferredCameraId()).toBeNull();
  expect(setItem).not.toHaveBeenCalled();
  main.stop();
  await expect(getPreferredCameraStream(mediaDevices)).resolves.toBe(reopened);
  expect(mediaDevices.getUserMedia.mock.calls[2][0].video.deviceId).toEqual({ exact: "focused" });
  expect(mediaDevices.enumerateDevices).toHaveBeenCalledOnce();
});

it("keeps the original lens on a live-capability tie and excludes front and specialist cameras", async () => {
  const first = camera("first"), other = camera("other"), restored = camera("first");
  const forbidden = ["Front Camera", "Back Ultra Wide", "Back Telephoto", "Back Macro", "Back Depth"]
    .map(label => ({ kind: "videoinput", deviceId: label, label }));
  const mediaDevices = {
    getUserMedia: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(other).mockResolvedValueOnce(restored),
    enumerateDevices: async () => [...forbidden, ...devices(["first", "other"])],
  };
  await expect(getPreferredCameraStream(mediaDevices)).resolves.toBe(restored);
  expect(mediaDevices.getUserMedia.mock.calls.map(([r]) => r.video.deviceId?.exact)).toEqual([undefined, "other", "first"]);
  expect(first.stop).toHaveBeenCalledOnce();
  expect(other.stop).toHaveBeenCalledOnce();
  expect(restored.stop).not.toHaveBeenCalled();
});

it("prefers autofocus over a light alone and bounds the number of ambiguous rear lenses inspected", async () => {
  const first = camera("first"), focus = camera("focus", { focusMode: ["continuous"] });
  const lit = camera("lit", { torch: true }), restored = camera("focus");
  const mediaDevices = {
    getUserMedia: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(focus)
      .mockResolvedValueOnce(lit).mockResolvedValueOnce(restored),
    enumerateDevices: async () => devices(["first", "focus", "lit", "extra"]),
  };
  await expect(getPreferredCameraStream(mediaDevices)).resolves.toBe(restored);
  expect(mediaDevices.getUserMedia.mock.calls.map(([r]) => r.video.deviceId?.exact)).toEqual([undefined, "focus", "lit", "focus"]);
});

it("restores the original after a slow probe and releases a late grant without touching the chosen stream", async () => {
  vi.useFakeTimers();
  const first = camera("first"), restored = camera("first"), late = camera("other");
  let grant;
  const mediaDevices = {
    getUserMedia: vi.fn().mockResolvedValueOnce(first).mockImplementationOnce(() => new Promise(resolve => { grant = resolve; }))
      .mockResolvedValueOnce(restored),
    enumerateDevices: async () => devices(["first", "other"]),
  };
  const opening = getPreferredCameraStream(mediaDevices);
  await vi.advanceTimersByTimeAsync(1500);
  await expect(opening).resolves.toBe(restored);
  grant(late);
  await vi.advanceTimersByTimeAsync(0);
  expect(first.stop).toHaveBeenCalledOnce();
  expect(late.stop).toHaveBeenCalledOnce();
  expect(restored.stop).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("stops a probe granted after close and never asks for a replacement camera", async () => {
  const first = camera("first"), late = camera("other");
  const controller = new AbortController();
  let grant;
  const mediaDevices = {
    getUserMedia: vi.fn().mockResolvedValueOnce(first).mockImplementationOnce(() => new Promise(resolve => { grant = resolve; })),
    enumerateDevices: async () => devices(["first", "other"]),
  };
  const opening = getPreferredCameraStream(mediaDevices, controller.signal);
  await vi.waitFor(() => expect(grant).toBeTypeOf("function"));
  controller.abort();
  await expect(opening).rejects.toMatchObject({ name: "AbortError" });
  grant(late);
  await vi.waitFor(() => expect(late.stop).toHaveBeenCalledOnce());
  expect(first.stop).toHaveBeenCalledOnce();
  expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
});

it.each(["NotAllowedError", "SecurityError"])("does not retry after %s during inspection", async name => {
  const first = camera("first"), error = new DOMException("Denied", name);
  const mediaDevices = { getUserMedia: vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(error),
    enumerateDevices: async () => devices(["first", "other"]) };
  await expect(getPreferredCameraStream(mediaDevices)).rejects.toBe(error);
  expect(first.stop).toHaveBeenCalledOnce();
  expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
});

it("rediscovers a camera when the automatically selected device disappears", async () => {
  const mediaDevices = { enumerateDevices: async () => devices(["first", "working"]),
    getUserMedia: vi.fn().mockResolvedValueOnce(camera("first"))
      .mockResolvedValueOnce(camera("working", { focusMode: ["continuous"], torch: true })) };
  const previous = await getPreferredCameraStream(mediaDevices);
  previous.stop();
  const fallback = camera("replacement");
  mediaDevices.enumerateDevices = async () => devices(["replacement"]);
  mediaDevices.getUserMedia.mockRejectedValueOnce(new DOMException("Gone", "NotFoundError")).mockResolvedValueOnce(fallback);
  await expect(getPreferredCameraStream(mediaDevices)).resolves.toBe(fallback);
  expect(mediaDevices.getUserMedia.mock.calls.at(-1)[0].video.deviceId).toBeUndefined();
});

it.each(["frame", "timeout", "close"])("inspects capabilities after streaming and releases the temporary video on %s", async outcome => {
  vi.useFakeTimers();
  const controller = new AbortController(), stream = camera("rear");
  const track = stream.getVideoTracks()[0];
  track.kind = "video";
  let ready = false;
  track.getCapabilities = () => ready ? { focusMode: ["continuous"], torch: true } : {};
  const video = Object.assign(new EventTarget(), { readyState: 0, pause: vi.fn(), play: vi.fn().mockResolvedValue() });
  vi.stubGlobal("document", { createElement: vi.fn(() => video) });
  const opening = inspectCameraCapabilities(stream, controller.signal);
  expect(video.srcObject).toBe(stream);
  expect(video.muted).toBe(true);
  expect(video.playsInline).toBe(true);
  if (outcome === "close") {
    controller.abort();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
  } else {
    if (outcome === "frame") { ready = true; video.dispatchEvent(new Event("loadeddata")); }
    else await vi.advanceTimersByTimeAsync(500);
    await expect(opening).resolves.toEqual(ready ? { focusMode: ["continuous"], torch: true } : {});
  }
  expect(video.pause).toHaveBeenCalledOnce();
  expect(video.srcObject).toBeNull();
  expect(stream.stop).not.toHaveBeenCalled();
  expect(stream.applyConstraints).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
