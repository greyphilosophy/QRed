/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { attachCameraLight, stillPhotoLighting } from "./cameraLight.js";
import { captureCameraPhoto } from "./cameraPhoto.js";

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => vi.unstubAllGlobals());

function setup({ modes = [false, true], flash = [], report = true, apply } = {}) {
  let torch = false;
  const track = { kind: "video", readyState: "live", getCapabilities: () => ({ torch: modes, exposureMode: ["continuous"] }),
    getSettings: () => report ? { torch } : {}, applyConstraints: vi.fn(async request => {
      if (apply) return apply(request);
      torch = request.torch?.exact ?? request.advanced.find(entry => "torch" in entry)?.torch;
    }) };
  const takePhoto = vi.fn().mockResolvedValue(new Blob());
  vi.stubGlobal("ImageCapture", class { getPhotoCapabilities() { return Promise.resolve({ fillLightMode: flash,
    imageWidth: { max: 4000 }, imageHeight: { max: 3000 } }); } takePhoto = takePhoto; });
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 4000, height: 3000, close() {} })));
  const button = document.createElement("button"), detach = attachCameraLight(button, track);
  const video = { srcObject: { getVideoTracks: () => [track] } };
  const canvas = { width: 1, height: 1, getContext: () => ({ drawImage() {}, getImageData: () => ({ width: 4000, height: 3000 }) }) };
  return { track, button, takePhoto, detach, capture: () => captureCameraPhoto(video, canvas) };
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

it("keeps unsupported lighting hidden and ignores late results from a released track", async () => {
  let finish;
  const { button, detach, track } = setup({ apply: () => new Promise(resolve => { finish = resolve; }) });
  button.click(); detach(); finish(); await flush();
  expect(button.hidden).toBe(true);
  expect(await stillPhotoLighting(track)).toEqual({ fillLightMode: "off" });
  const other = setup({ modes: [false], flash: ["off"] });
  await flush(); expect(other.button.hidden).toBe(true);
});
