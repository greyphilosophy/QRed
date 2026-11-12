/* @vitest-environment jsdom */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QrScanner } from "./QrScanner.jsx";

const camera = vi.hoisted(() => ({ options: null, live: null, previewScan: vi.fn(), scan: vi.fn() }));
vi.mock("./qr/cameraSession.js", () => ({ startCameraSession: options => {
  camera.options = options; return { stop: vi.fn() };
} }));
vi.mock("./qr/photoScanClient.js", () => ({ preparePhotoScanner: vi.fn(), scanPhotoInWorker: camera.scan,
  createLiveScanWorker: options => { camera.live = options; return { busy: false, scan: camera.previewScan, reset: vi.fn(), stop: vi.fn() }; },
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); camera.scan.mockReset(); camera.previewScan.mockReset(); });

function open(props = {}) {
  // The browser interfaces are mocked; use complete, distinct frame buffers
  // to prove the real capture helper sends and retains the same source pixels.
  const preview = { width: 1920, height: 1080, data: new Uint8ClampedArray(1920 * 1080 * 4).fill(1) };
  const still = { width: 4000, height: 3000, data: new Uint8ClampedArray(4000 * 3000 * 4).fill(2) };
  const bitmap = { width: 4000, height: 3000, close: vi.fn() };
  const pixelReads = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function () {
    return { drawImage: source => { this.retainedPixels = source === bitmap ? still : preview; },
      getImageData: (_x, _y, width, height) => { pixelReads.push([width, height]); return this.retainedPixels; } };
  });
  const track = { kind: "video", readyState: "live", label: "private camera", deviceId: "private ID" };
  render(React.createElement(QrScanner, { collectSeals: true, returnPayload: true, ...props }));
  fireEvent.click(screen.getByRole("button", { name: "Check document" }));
  const video = camera.options.video;
  video.srcObject = { getVideoTracks: () => [track] };
  Object.defineProperties(video, { readyState: { value: 2, configurable: true }, videoWidth: { value: 1920, configurable: true }, videoHeight: { value: 1080, configurable: true } });
  act(() => camera.options.onFrame());
  camera.scan.mockResolvedValue({ status: "feedback", timedOut: true, message: "Try another capture." });
  return { preview, still, bitmap, pixelReads, canvas: document.querySelector("canvas") };
}

it.each(["manual", "automatic"])("uses native still pixels after unavailable capability discovery during %s capture", async mode => {
  const { still, bitmap, pixelReads, canvas } = open();
  const takePhoto = vi.fn().mockResolvedValue(new Blob());
  vi.stubGlobal("ImageCapture", vi.fn(function () { return {
    getPhotoCapabilities: () => Promise.reject(new DOMException("private device detail", "NotSupportedError")), takePhoto,
  }; }));
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  act(() => camera.live.onQuality({ state: mode === "manual" ? "small" : "ready", message: "Safe guide" }));
  if (mode === "manual") fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  else act(() => camera.live.onCaptured({ captureOnly: true }));
  await waitFor(() => expect(camera.scan).toHaveBeenCalledTimes(1));
  expect(camera.scan.mock.calls[0][0]).toBe(still);
  // One guidance sample, then the native still. No full-size video copy at the shutter.
  expect(pixelReads).toEqual([[1280, 720], [4000, 3000]]);
  expect(canvas.retainedPixels).toBe(still);
  expect(canvas.width).toBe(4000); expect(canvas.height).toBe(3000);
  expect(takePhoto).toHaveBeenCalledWith({ fillLightMode: "off" });
  expect(await screen.findByText(/Camera photo: 4000 × 3000/)).toBeTruthy();
  expect(document.body.textContent).toContain(`${mode} capture, 1920 × 1080 preview, last guide: ${mode === "manual" ? "page too small" : "steady hold passed"}`);
  expect(document.body.textContent).not.toMatch(/private device detail|private camera|private ID/);
  expect(screen.getByRole("button", { name: "Save scan photo" })).toBeTruthy();
  camera.previewScan.mockClear();
  act(() => camera.options.onFrame());
  expect(camera.previewScan).not.toHaveBeenCalled();
});

it("finishes a captured photo if the camera cannot reopen on return to the tab", async () => {
  const onSealDetected = vi.fn();
  const { bitmap, canvas } = open({ onSealDetected });
  vi.stubGlobal("ImageCapture", vi.fn(function () { return { takePhoto: async () => new Blob() }; }));
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  let finish;
  camera.scan.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  await screen.findByText("Photo captured. You can move your phone.");
  act(() => { camera.options.onStream(null); camera.options.onError(new Error("Camera busy"), "access"); });
  expect(screen.getByText("Photo captured. You can move your phone.")).toBeTruthy();
  expect(camera.scan.mock.calls[0][1].signal.aborted).toBe(false);
  await act(async () => finish({ status: "found", text: "retained QR" }));
  expect(onSealDetected).toHaveBeenCalledWith("retained QR", canvas);
});

it("stops before seal decoding when native photo capture fails", async () => {
  const { preview, canvas } = open();
  vi.stubGlobal("ImageCapture", vi.fn(function () { return {
    getPhotoCapabilities: () => Promise.resolve({}),
    takePhoto: () => Promise.reject(new DOMException("private hardware detail", "OperationError")),
  }; }));
  vi.stubGlobal("createImageBitmap", vi.fn());
  fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  expect(await screen.findByText(/The camera could not take a photo.*No video frame was scanned/)).toBeTruthy();
  expect(camera.scan).not.toHaveBeenCalled();
  expect(canvas.retainedPixels).toBe(preview);
  expect(document.body.textContent).not.toContain("private hardware detail");
  const before = camera.previewScan.mock.calls.length;
  act(() => camera.options.onFrame());
  expect(camera.previewScan).toHaveBeenCalledTimes(before);
  expect(screen.getByRole("button", { name: "Capture now" })).toBeTruthy();
});

it("uses video only for framing and refuses to decode it when native photos are unavailable", async () => {
  open();
  expect(camera.previewScan.mock.calls[0][1]).toEqual({ captureOnly: true });
  act(() => camera.live.onCaptured({ captureOnly: true }));
  expect(await screen.findByText(/This browser cannot take a full-resolution camera photo/)).toBeTruthy();
  expect(camera.scan).not.toHaveBeenCalled();
});

it("does not decode an insufficiently detailed native photo", async () => {
  const { preview, canvas } = open();
  vi.stubGlobal("ImageCapture", vi.fn(function () { return { takePhoto: () => Promise.resolve(new Blob()) }; }));
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 1920, height: 1080, close: vi.fn() }));
  fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  expect(await screen.findByText(/photo is too small/)).toBeTruthy();
  expect(camera.scan).not.toHaveBeenCalled();
  expect(canvas.retainedPixels).toBe(preview);
});

it("does not attach an earlier photo's dimensions to a new attempt that never receives a frame", async () => {
  const { bitmap } = open();
  vi.stubGlobal("ImageCapture", vi.fn(function () { return { takePhoto: () => Promise.resolve(new Blob()) }; }));
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  await screen.findByText(/Camera photo: 4000 × 3000/);
  Object.defineProperty(camera.options.video, "videoWidth", { value: 0 });
  const now = vi.spyOn(performance, "now").mockReturnValue(1000);
  fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  now.mockReturnValue(5000);
  act(() => camera.options.onFrame());
  const feedback = screen.getByText(/not delivering photo frames yet/);
  expect(feedback.textContent).not.toMatch(/Camera photo:|Camera frame:/);
  expect(camera.scan).toHaveBeenCalledTimes(1);
});

it("offers explicit photo selection and cancels a pending native capture before leaving the camera", async () => {
  const choose = vi.fn(), { bitmap } = open({ onChoosePhoto: choose });
  let finish;
  const takePhoto = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  vi.stubGlobal("ImageCapture", vi.fn(function () { return { takePhoto }; }));
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  await waitFor(() => expect(takePhoto).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Choose photo" }));
  expect(choose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Capture now" })).toBeNull();
  await act(async () => finish(new Blob()));
  expect(camera.scan).not.toHaveBeenCalled();
  expect(createImageBitmap).not.toHaveBeenCalled();
});

it.each(["manual", "automatic"])("shows live decoder steps for %s camera photos and clears them after cancellation", async mode => {
  const { bitmap } = open();
  vi.stubGlobal("ImageCapture", vi.fn(function () { return { takePhoto: () => Promise.resolve(new Blob()) }; }));
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  let finish;
  camera.scan.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  if (mode === "manual") fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  else act(() => camera.live.onCaptured({ captureOnly: true }));
  await waitFor(() => expect(camera.scan).toHaveBeenCalledTimes(1));
  const { onStage } = camera.scan.mock.calls[0][1];
  expect(screen.getByRole("progressbar").hasAttribute("value")).toBe(false);
  act(() => onStage({ stage: "ordinary-qr", elapsedMs: 500 }));
  expect(screen.getByText(/reading conventional QR codes/i)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel and resume camera" }));
  expect(screen.queryByRole("progressbar")).toBeNull();
  act(() => onStage({ stage: "footer", elapsedMs: 900 }));
  await act(async () => finish({ status: "feedback", message: "Stale result" }));
  expect(screen.queryByText(/checking footer seals/i)).toBeNull();
  expect(screen.queryByText("Stale result")).toBeNull();
});

it("keeps the new camera attempt's progress when an aborted decoder finishes late", async () => {
  const { bitmap } = open();
  vi.stubGlobal("ImageCapture", vi.fn(function () { return { takePhoto: () => Promise.resolve(new Blob()) }; }));
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  const finishes = [];
  camera.scan.mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
  fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  await waitFor(() => expect(camera.scan).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Cancel and resume camera" }));
  fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  await waitFor(() => expect(camera.scan).toHaveBeenCalledTimes(2));
  const oldStage = camera.scan.mock.calls[0][1].onStage, newStage = camera.scan.mock.calls[1][1].onStage;
  act(() => newStage({ stage: "page-aligned", elapsedMs: 100 }));
  await act(async () => { oldStage({ stage: "footer", elapsedMs: 900 }); finishes[0]({ status: "feedback", message: "Old photo" }); });
  expect(screen.getByText(/checking page layouts/i)).toBeTruthy();
  expect(screen.queryByText(/checking footer seals/i)).toBeNull();
  await act(async () => finishes[1]({ status: "feedback", message: "New photo" }));
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByText(/New photo/)).toBeTruthy();
});

it("reports live-frame decoder stages and clears them on a result", () => {
  open({ collectSeals: false });
  act(() => camera.live.onCaptured());
  act(() => camera.live.onStage({ stage: "watermark-preview", elapsedMs: 200 }));
  expect(screen.getByText(/checking the watermark/i)).toBeTruthy();
  act(() => camera.live.onResult({ status: "feedback", message: "Try again" }));
  expect(screen.queryByRole("progressbar")).toBeNull();
  act(() => camera.live.onStage({ stage: "footer", elapsedMs: 500 }));
  expect(screen.queryByText(/checking footer seals/i)).toBeNull();
});

it.each([
  [true, "drawImage"], [true, "getImageData"], [false, "drawImage"], [false, "getImageData"],
])("clears progress and permits retry when document mode is %s and %s fails", async (collectSeals, method) => {
  const { bitmap } = open({ collectSeals });
  vi.stubGlobal("ImageCapture", vi.fn(function () { return { takePhoto: () => Promise.resolve(new Blob()) }; }));
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  const intervals = vi.spyOn(globalThis, "setInterval"), clear = vi.spyOn(globalThis, "clearInterval");
  HTMLCanvasElement.prototype.getContext.mockImplementationOnce(() => ({
    drawImage: () => { if (method === "drawImage") throw new Error("private readback failure"); },
    getImageData: () => { throw new Error("private readback failure"); },
  }));
  fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  expect(await screen.findByText(/camera frame could not be read/)).toBeTruthy();
  expect(document.body.textContent).not.toContain("private readback failure");
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(clear).toHaveBeenCalledWith(intervals.mock.results.at(-1).value);
  expect(camera.scan).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Capture now" }).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  await waitFor(() => expect(camera.scan).toHaveBeenCalledTimes(1));
  expect(await screen.findByText(/Try another capture/)).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
});
