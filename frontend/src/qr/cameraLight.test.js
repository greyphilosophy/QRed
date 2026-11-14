/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createPhotoScanProgress } from "./photoScanProgress.js";
import { attachCameraLight, stillPhotoLighting } from "./cameraLight.js";
import { captureCameraPhoto } from "./cameraPhoto.js";

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function setup({ modes = [false, true], flash = [], report = true, apply, photoCaps } = {}) {
  let torch = false;
  const canReport = typeof report === "function" ? report : () => report;
  const track = { kind: "video", readyState: "live", getCapabilities: () => ({ torch: modes, exposureMode: ["continuous"] }),
    getSettings: () => canReport(torch) ? { torch } : {}, applyConstraints: vi.fn(async request => {
      if (apply) return apply(request);
      torch = request.torch?.exact ?? request.advanced.find(entry => "torch" in entry)?.torch;
    }) };
  const takePhoto = vi.fn().mockResolvedValue(new Blob());
  vi.stubGlobal("ImageCapture", class { getPhotoCapabilities() { return photoCaps ? photoCaps() : Promise.resolve({ fillLightMode: flash,
    imageWidth: { max: 4000 }, imageHeight: { max: 3000 } }); } takePhoto = takePhoto; });
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 4000, height: 3000, close() {} })));
  const button = document.createElement("button"), hint = document.createElement("p");
  hint.id = "light-help"; button.setAttribute("aria-describedby", hint.id);
  document.body.replaceChildren(button, hint);
  const video = document.createElement("video"), progress = createPhotoScanProgress();
  video.srcObject = { getVideoTracks: () => [track] };
  const detach = attachCameraLight(button, track, { video, progress });
  const canvas = { width: 1, height: 1, getContext: () => ({ drawImage() {}, getImageData: () => ({ width: 4000, height: 3000 }) }) };
  return { track, video, progress, button, hint, takePhoto, detach, capture: () => captureCameraPhoto(video, canvas) };
}

it.each(["torch", "flash"])("holds the chosen %s through a native shutter and dimension retry", async mode => {
  const { button, track, takePhoto, capture } = setup({ modes: mode === "torch", flash: ["off", "flash"] });
  await flush();
  button.click();
  takePhoto.mockRejectedValueOnce(new DOMException("size", "OverconstrainedError"));
  await capture();
  const lighting = mode === "flash" ? { fillLightMode: "flash" } : {};
  expect(takePhoto.mock.calls).toEqual([[{ ...lighting, imageWidth: 4000, imageHeight: 3000 }], [lighting]]);
  expect(track.getSettings().torch).toBe(mode === "torch");
  button.click(); await flush();
  expect(await stillPhotoLighting(track)).toEqual({ fillLightMode: "off" });
});

it("falls back to a shutter flash when the driver silently skips both torch requests", async () => {
  const { track, button } = setup({ flash: ["flash"], apply: async () => {} });
  await flush(); button.click(); await flush();
  expect(track.applyConstraints).toHaveBeenCalledTimes(2);
  expect(button.textContent).toBe("Photo flash on");
  expect(await stillPhotoLighting(track)).toEqual({ fillLightMode: "flash" });
});

it("shows unavailable if requested lighting fails and has no shutter alternative", async () => {
  const { track, button } = setup({ apply: async () => { throw new DOMException("denied", "SecurityError"); } });
  button.click(); await flush();
  expect(button.textContent).toBe("Flashlight unavailable");
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(track.applyConstraints).toHaveBeenCalledTimes(1);
});

it("keeps an unsupported light visible, with Camera app guidance on tap", async () => {
  const { button, hint, track, detach } = setup({ modes: [false], flash: ["off"] });
  await flush();
  expect(button.hidden).toBe(false);
  expect(button.textContent).toBe("Flashlight unavailable");
  button.click(); await flush();
  expect(hint.textContent).toMatch(/Camera app.*Choose photo/);
  expect(track.applyConstraints).not.toHaveBeenCalled();
  expect(await stillPhotoLighting(track)).toEqual({ fillLightMode: "off" });
  detach();
  expect(button.hidden).toBe(true);
  expect(hint.textContent).toBe("");
});

it("ignores late results after the camera closes", async () => {
  let finish;
  const { button, detach, track } = setup({ apply: () => new Promise(resolve => { finish = resolve; }) });
  button.click(); detach(); finish(); await flush();
  expect(button.hidden).toBe(true);
  expect(await stillPhotoLighting(track)).toEqual({ fillLightMode: "off" });
});

it("rechecks the preview torch and photo flash when playback starts", async () => {
  const modes = [];
  const { track, button, video } = setup({ modes, report: false });
  expect(button.textContent).toBe("Try flashlight");
  modes.push(false, true);
  video.dispatchEvent(new Event("playing"));
  expect(button.textContent).toBe("Flashlight off");
  expect(track.applyConstraints).not.toHaveBeenCalled();
  let streaming = false;
  const shutter = setup({ modes: false, photoCaps: () => {
    if (!streaming) throw new Error("Camera starting");
    return Promise.resolve({ fillLightMode: ["flash"] });
  } });
  streaming = true;
  shutter.video.dispatchEvent(new Event("playing")); await flush();
  expect(shutter.button.textContent).toBe("Photo flash off");
});

it("accepts an unadvertised torch only after the driver confirms the change", async () => {
  let hasReported = false;
  const confirmed = setup({ modes: [], report: on => { if (on) hasReported = true; return hasReported; } });
  confirmed.button.click(); await flush();
  expect(confirmed.button.textContent).toBe("Flashlight on");
  expect(await stillPhotoLighting(confirmed.track)).toEqual({});
  confirmed.button.click(); await flush();
  expect(confirmed.button.textContent).toBe("Flashlight off");
  const ignored = setup({ modes: [], report: false, apply: async () => {} });
  ignored.button.click(); await flush();
  expect(ignored.button.textContent).toBe("Flashlight unavailable");
  expect(ignored.button.getAttribute("aria-pressed")).toBe("false");
  expect(ignored.hint.textContent).toMatch(/Camera app/);
});

it("keeps a late discovery from enabling the light during capture", async () => {
  let finish;
  const { button, progress, track, detach } = setup({ modes: false, photoCaps: () => new Promise(resolve => { finish = resolve; }) });
  const capture = progress.begin("capturing");
  finish({ fillLightMode: ["flash"] }); await flush();
  expect(button.textContent).toBe("Photo flash off");
  expect(button.disabled).toBe(true);
  button.click();
  expect(await stillPhotoLighting(track)).toEqual({ fillLightMode: "off" });
  capture.stop();
  expect(button.disabled).toBe(false);
  detach();
  expect(button.hidden).toBe(true);
});

it("releases the shutter and explains the fallback if the camera never answers a light request", async () => {
  vi.useFakeTimers();
  const never = () => new Promise(() => {});
  const { track, button, hint } = setup({ modes: [], report: false, apply: never, photoCaps: never });
  button.click();
  const lighting = stillPhotoLighting(track);
  await vi.advanceTimersByTimeAsync(1600);
  expect(await lighting).toEqual({ fillLightMode: "off" });
  expect(button.textContent).toBe("Flashlight unavailable");
  expect(hint.textContent).toMatch(/Choose photo/);
  expect(button.disabled).toBe(false);
});
