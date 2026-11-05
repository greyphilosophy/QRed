/* @vitest-environment jsdom */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QrScanner } from "./QrScanner.jsx";

const camera = vi.hoisted(() => ({ options: null, live: null, scan: vi.fn() }));
vi.mock("./qr/cameraSession.js", () => ({ startCameraSession: options => {
  camera.options = options; return { stop: vi.fn() };
} }));
vi.mock("./qr/photoScanClient.js", () => ({ preparePhotoScanner: vi.fn(), scanPhotoInWorker: camera.scan,
  createLiveScanWorker: options => { camera.live = options; return { busy: false, scan: vi.fn(), reset: vi.fn(), stop: vi.fn() }; },
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); camera.scan.mockReset(); });

function open() {
  // The browser interfaces are mocked; use complete, distinct frame buffers
  // to prove the real capture helper sends and retains the same source pixels.
  const preview = { width: 1920, height: 1080, data: new Uint8ClampedArray(1920 * 1080 * 4).fill(1) };
  const still = { width: 4000, height: 3000, data: new Uint8ClampedArray(4000 * 3000 * 4).fill(2) };
  const bitmap = { width: 4000, height: 3000, close: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function () {
    return { drawImage: source => { this.retainedPixels = source === bitmap ? still : preview; },
      getImageData: () => this.retainedPixels };
  });
  const track = { kind: "video", readyState: "live", label: "private camera", deviceId: "private ID" };
  render(React.createElement(QrScanner, { collectSeals: true, returnPayload: true }));
  fireEvent.click(screen.getByRole("button", { name: "Check document" }));
  const video = camera.options.video;
  video.srcObject = { getVideoTracks: () => [track] };
  Object.defineProperties(video, { readyState: { value: 2, configurable: true }, videoWidth: { value: 1920, configurable: true }, videoHeight: { value: 1080, configurable: true } });
  act(() => camera.options.onFrame());
  camera.scan.mockResolvedValue({ status: "feedback", timedOut: true, message: "Try another capture." });
  return { preview, still, bitmap, canvas: document.querySelector("canvas") };
}

it.each(["manual", "automatic"])("uses native still pixels after unavailable capability discovery during %s capture", async mode => {
  const { still, bitmap, canvas } = open();
  const takePhoto = vi.fn().mockResolvedValue(new Blob());
  vi.stubGlobal("ImageCapture", vi.fn(function () { return {
    getPhotoCapabilities: () => Promise.reject(new DOMException("private device detail", "NotSupportedError")), takePhoto,
  }; }));
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  if (mode === "manual") fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  else act(() => camera.live.onCaptured({ captureOnly: true }));
  await waitFor(() => expect(camera.scan).toHaveBeenCalledTimes(1));
  expect(camera.scan.mock.calls[0][0]).toBe(still);
  expect(canvas.retainedPixels).toBe(still);
  expect(canvas.width).toBe(4000); expect(canvas.height).toBe(3000);
  expect(takePhoto).toHaveBeenCalledWith({ fillLightMode: "off" });
  expect(await screen.findByText(/Camera photo: 4000 × 3000/)).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/private device detail|private camera|private ID/);
});

it("retains preview pixels and reports the actual source when still capture fails", async () => {
  const { preview, canvas } = open();
  vi.stubGlobal("ImageCapture", vi.fn(function () { return {
    getPhotoCapabilities: () => Promise.resolve({}),
    takePhoto: () => Promise.reject(new DOMException("private hardware detail", "OperationError")),
  }; }));
  vi.stubGlobal("createImageBitmap", vi.fn());
  fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  await waitFor(() => expect(camera.scan).toHaveBeenCalledTimes(1));
  expect(camera.scan.mock.calls[0][0].data).toBe(preview.data);
  expect(camera.scan.mock.calls[0][0].width).toBe(1920);
  expect(camera.scan.mock.calls[0][0].height).toBe(1080);
  expect(canvas.retainedPixels).toBe(preview);
  expect(canvas.width).toBe(1920); expect(canvas.height).toBe(1080);
  expect(await screen.findByText(/Camera frame: 1920 × 1080. Still photo capture failed/)).toBeTruthy();
  expect(document.body.textContent).not.toContain("private hardware detail");
});

it("reports dimensions of the frozen automatic preview rather than the later live video", () => {
  const { canvas } = open();
  act(() => camera.live.onCaptured());
  // A later camera change must not change metadata about the submitted frame.
  canvas.width = 1280; canvas.height = 720;
  act(() => camera.live.onResult({ status: "feedback", timedOut: true, message: "Try again." }));
  expect(screen.getByText(/Camera frame: 1920 × 1080/)).toBeTruthy();
  expect(camera.scan).not.toHaveBeenCalled();
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
