/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const storageKey = "qred.document-camera.v1";
const trackFor = deviceId => ({ getSettings: () => ({ deviceId, facingMode: "environment" }) });
beforeEach(() => { localStorage.clear(); vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it("reopens the confirmed camera during this visit without storing it or requesting lighting", async () => {
  const { rememberPreferredCamera } = await import("./cameraPreference.js");
  const getItem = vi.spyOn(Storage.prototype, "getItem"), setItem = vi.spyOn(Storage.prototype, "setItem");
  expect(rememberPreferredCamera(trackFor("working-rear"))).toBe("working-rear");
  expect({ ...localStorage }).toEqual({});
  const { getPreferredCameraStream, QR_CAMERA_CONSTRAINTS } = await import("./cameraControls.js");
  const stream = { getTracks: () => [] };
  const mediaDevices = { getUserMedia: vi.fn(async () => stream), enumerateDevices: vi.fn() };
  await expect(getPreferredCameraStream(mediaDevices)).resolves.toBe(stream);
  expect(mediaDevices.getUserMedia).toHaveBeenCalledOnce();
  expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({ video: {
    ...QR_CAMERA_CONSTRAINTS.video, deviceId: { exact: "working-rear" },
  } });
  expect(mediaDevices.enumerateDevices).not.toHaveBeenCalled();
  expect(getItem).not.toHaveBeenCalled();
  expect(setItem).not.toHaveBeenCalled();
});

it("discards the previous visit's choice and removes only the legacy preference on load", async () => {
  const { rememberPreferredCamera } = await import("./cameraPreference.js");
  rememberPreferredCamera(trackFor("previous-visit"));
  localStorage.setItem(storageKey, "legacy-camera");
  localStorage.setItem("unrelated", "keep");
  vi.resetModules();
  const { getPreferredCameraStream, QR_CAMERA_CONSTRAINTS } = await import("./cameraControls.js");
  const { preferredCameraId } = await import("./cameraPreference.js");
  expect({ ...localStorage }).toEqual({ unrelated: "keep" });
  expect(preferredCameraId()).toBeNull();
  const stream = { getTracks: () => [] };
  const mediaDevices = { getUserMedia: vi.fn(async () => stream), enumerateDevices: async () => [] };
  await expect(getPreferredCameraStream(mediaDevices)).resolves.toBe(stream);
  expect(mediaDevices.getUserMedia).toHaveBeenCalledOnce();
  expect(mediaDevices.getUserMedia).toHaveBeenCalledWith(QR_CAMERA_CONSTRAINTS);
});

it.each(["OverconstrainedError", "NotFoundError"])("forgets a missing camera after %s and uses normal selection next time", async name => {
  const { rememberPreferredCamera } = await import("./cameraPreference.js");
  rememberPreferredCamera(trackFor("old-device-id"));
  const { getPreferredCameraStream, QR_CAMERA_CONSTRAINTS } = await import("./cameraControls.js");
  const { preferredCameraId } = await import("./cameraPreference.js");
  const stream = { getTracks: () => [] };
  const getUserMedia = vi.fn().mockRejectedValueOnce(new DOMException("Unavailable", name)).mockResolvedValue(stream);
  const mediaDevices = { getUserMedia, enumerateDevices: async () => [] };
  await expect(getPreferredCameraStream(mediaDevices)).resolves.toBe(stream);
  expect(preferredCameraId()).toBeNull();
  expect(localStorage.getItem(storageKey)).toBeNull();
  await expect(getPreferredCameraStream(mediaDevices)).resolves.toBe(stream);
  expect(getUserMedia.mock.calls.map(([request]) => request)).toEqual([
    { video: { ...QR_CAMERA_CONSTRAINTS.video, deviceId: { exact: "old-device-id" } } },
    QR_CAMERA_CONSTRAINTS, QR_CAMERA_CONSTRAINTS,
  ]);
});

it.each(["NotAllowedError", "SecurityError"])("does not retry permission after %s or forget the working camera", async name => {
  const { preferredCameraId, rememberPreferredCamera } = await import("./cameraPreference.js");
  rememberPreferredCamera(trackFor("working-rear"));
  const { getPreferredCameraStream } = await import("./cameraControls.js");
  const error = new DOMException("Permission denied", name);
  const getUserMedia = vi.fn().mockRejectedValue(error);
  await expect(getPreferredCameraStream({ getUserMedia })).rejects.toBe(error);
  expect(getUserMedia).toHaveBeenCalledOnce();
  expect(preferredCameraId()).toBe("working-rear");
  expect(localStorage.getItem(storageKey)).toBeNull();
});

it("releases a remembered lens granted after the scanner closes", async () => {
  const { preferredCameraId, rememberPreferredCamera } = await import("./cameraPreference.js");
  rememberPreferredCamera(trackFor("working-rear"));
  const { getPreferredCameraStream } = await import("./cameraControls.js");
  const controller = new AbortController(), stop = vi.fn();
  let grant;
  const getUserMedia = vi.fn(() => new Promise(resolve => { grant = resolve; }));
  const opening = getPreferredCameraStream({ getUserMedia }, controller.signal);
  controller.abort();
  grant({ getTracks: () => [{ stop }] });
  await expect(opening).rejects.toMatchObject({ name: "AbortError" });
  expect(stop).toHaveBeenCalledOnce();
  expect(getUserMedia).toHaveBeenCalledOnce();
  expect(preferredCameraId()).toBe("working-rear");
  expect(localStorage.getItem(storageKey)).toBeNull();
});

it("keeps the choice for this page when persistent storage is blocked", async () => {
  const blocked = () => { throw new DOMException("Blocked", "SecurityError"); };
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(blocked);
  const { preferredCameraId, rememberPreferredCamera, forgetPreferredCamera } = await import("./cameraPreference.js");
  expect(preferredCameraId()).toBeNull();
  rememberPreferredCamera(trackFor("working-rear"));
  expect(preferredCameraId()).toBe("working-rear");
  forgetPreferredCamera("working-rear");
  expect(preferredCameraId()).toBeNull();
});

it("ignores unavailable IDs and known front cameras and preserves a newer choice after a stale failure", async () => {
  const { preferredCameraId, rememberPreferredCamera, forgetPreferredCamera } = await import("./cameraPreference.js");
  expect(preferredCameraId()).toBeNull();
  for (const track of [null, {}, trackFor(""), trackFor(undefined), trackFor("x".repeat(513)),
    { getSettings() { throw new Error("Unavailable"); } },
    { getSettings: () => ({ deviceId: "front", facingMode: "user" }) }]) {
    expect(rememberPreferredCamera(track)).toBeNull();
  }
  expect(preferredCameraId()).toBeNull();
  rememberPreferredCamera(trackFor("first-rear"));
  rememberPreferredCamera(trackFor("second-rear"));
  forgetPreferredCamera("first-rear");
  expect(preferredCameraId()).toBe("second-rear");
  expect(localStorage.getItem(storageKey)).toBeNull();
});
