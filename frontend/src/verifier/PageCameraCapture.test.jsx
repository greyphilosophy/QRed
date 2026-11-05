/* @vitest-environment jsdom */
/* eslint-disable no-unused-vars */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQRedSeals } from "../qredSealer.js";
import { qrPayloadBytes, sealString } from "../sealFormat.js";
import { decodeSeal } from "../qredVerifier.js";
import { PageCameraCapture, confirmsPageSeal } from "./PageCameraCapture.jsx";
import { photoScanTimeoutAction } from "../qr/photoScanBudget.js";

const camera = vi.hoisted(() => ({ stop: vi.fn(), options: null, snapshot: vi.fn(), scan: vi.fn(), reset: vi.fn(), liveOptions: null, liveScan: vi.fn() }));
vi.mock("../qr/cameraSession.js", () => ({ startCameraSession: options => { camera.options = options; return { stop: camera.stop }; } }));
vi.mock("../qr/photoScanClient.js", () => ({ scanPhotoInWorker: camera.scan, createLiveScanWorker: options => {
  camera.liveOptions = options;
  return { busy: false, scan: camera.liveScan, reset: camera.reset, stop: vi.fn() };
} }));
vi.mock("./scanPhotos.js", () => ({ snapshotScanPhoto: camera.snapshot }));
beforeEach(() => {
  vi.stubGlobal("ImageCapture", vi.fn(function () { return { takePhoto: () => Promise.resolve(new Blob()) }; }));
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 2000, height: 3000, close: vi.fn() }));
});
afterEach(() => { vi.useRealTimers(); cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
const signed = await createQRedSeals({ content: "Friday", privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=",
  publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=" });
const track = { kind: "video", readyState: "live" };
function ready() {
  camera.options.video.srcObject = { getVideoTracks: () => [track] };
  Object.defineProperties(camera.options.video, { videoWidth: { value: 800 }, videoHeight: { value: 1000 } });
  act(() => camera.options.onFrame());
}
it("keeps the hold interval between preview frames and rearms after a rejected page", async () => {
  render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={vi.fn()} onClose={vi.fn()} />);
  act(() => camera.liveOptions.onResult({ status: "continue" }));
  expect(camera.reset).not.toHaveBeenCalled();
  await act(async () => camera.liveOptions.onResult({ status: "found", text: "wrong page" }));
  expect(camera.reset).toHaveBeenCalledTimes(1);
  expect(camera.snapshot).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("does not match Page 2");
});
it("captures a native photo and releases its canvas and camera without saving a file", async () => {
  const file = new Blob(["temporary pixels"], { type: "image/png" }), capture = vi.fn(), close = vi.fn();
  camera.snapshot.mockResolvedValue(file);
  camera.scan.mockResolvedValue({ status: "found", text: signed.seals[0] });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn(), getImageData: vi.fn(() => ({})) });
  const storage = vi.spyOn(Storage.prototype, "setItem"), download = vi.spyOn(HTMLAnchorElement.prototype, "click");
  const view = render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={capture} onClose={close} />);
  ready(); fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  await waitFor(() => expect(capture).toHaveBeenCalledWith(file));
  expect(camera.stop).toHaveBeenCalled(); expect(close).toHaveBeenCalled();
  expect(camera.snapshot.mock.calls[0][0].width).toBe(0);
  expect(view.container.querySelector("input[type=file]").accept).toBe("image/*");
  expect(camera.liveScan.mock.calls[0][1]).toEqual({ captureOnly: true });
  expect(storage).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled();
});
it("discards a retake that finishes after the session is closed", async () => {
  let finish;
  camera.snapshot.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn(), getImageData: vi.fn(() => ({})) });
  const capture = vi.fn(), view = render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={capture} onClose={vi.fn()} />);
  camera.scan.mockResolvedValue({ status: "found", text: signed.seals[0] });
  ready(); fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  view.unmount(); await act(async () => finish(new Blob(["late"])));
  expect(capture).not.toHaveBeenCalled(); expect(camera.stop).toHaveBeenCalled();
});

it("rejects an identifier-only match, missing seals, and a different authenticated page", async () => {
  const other = await createQRedSeals({ content: "Monday", privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=",
    publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=" });
  expect(confirmsPageSeal({text: signed.seals[0].split("#")[1]}, signed.seals)).toBe(true);
  expect(confirmsPageSeal({text: other.seals[0]}, signed.seals)).toBe(false);
  expect(confirmsPageSeal({status: "feedback"}, signed.seals)).toBe(false);
  expect(confirmsPageSeal({texts: [signed.seals[0], other.seals[0]]}, signed.seals)).toBe(false);
  camera.scan.mockResolvedValue({ status: "found", text: other.seals[0] });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn(), getImageData: vi.fn(() => ({})) });
  const capture = vi.fn();
  render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={capture} onClose={vi.fn()} />);
  ready(); fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("does not match Page 2"));
  expect(capture).not.toHaveBeenCalled(); expect(camera.snapshot).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Capture now" }).disabled).toBe(false);
});
it("aborts the seal reader when a retake is cancelled", async () => {
  let finish;
  camera.scan.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn(), getImageData: vi.fn(() => ({})) });
  const capture = vi.fn(), view = render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={capture} onClose={vi.fn()} />);
  ready(); fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  await waitFor(() => expect(camera.scan).toHaveBeenCalled());
  const signal = camera.scan.mock.calls[0][1].signal;
  view.unmount(); expect(signal.aborted).toBe(true);
  await act(async () => finish({text: signed.seals[0]}));
  expect(capture).not.toHaveBeenCalled(); expect(camera.snapshot).not.toHaveBeenCalled();
});
it("rejects changed chunk bytes even when the untrusted page identifier is unchanged", async () => {
  const chunked = await createQRedSeals({ content: "A".repeat(3000), encodingStrategy: "plaintext",
    privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=", publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=" });
  const bytes = qrPayloadBytes(chunked.seals[0]); bytes[bytes.length - 1] ^= 1;
  const altered = sealString(bytes);
  expect(decodeSeal(altered).document_id).toBe(decodeSeal(chunked.seals[0]).document_id);
  expect(confirmsPageSeal({ text: altered }, chunked.seals)).toBe(false);
});

it("keeps automatic capture paused after a timeout and leaves Capture now available", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn(), getImageData: vi.fn(() => ({})) });
  render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={vi.fn()} onClose={vi.fn()} />);
  ready();
  act(() => camera.liveOptions.onCaptured());
  act(() => camera.liveOptions.onResult({ status: "feedback", timedOut: true, message: "Use Capture now to try again." }));
  expect(camera.reset).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toContain("Capture now");
  expect(screen.getByRole("alert").textContent).toContain("Camera frame: 800 × 1000");
  expect(screen.getByRole("button", { name: "Capture now" }).disabled).toBe(false);
});

it("sends native still pixels to retake decoding and preserves their dimensions in timeout guidance", async () => {
  const pixels = { width: 2000, height: 3000, data: new Uint8ClampedArray(4) };
  const bitmap = { width: 2000, height: 3000, close: vi.fn() };
  const context = { drawImage: vi.fn(), getImageData: vi.fn(() => pixels) };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  vi.stubGlobal("ImageCapture", vi.fn(function () { return { takePhoto: () => Promise.resolve(new Blob()) }; }));
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  camera.scan.mockResolvedValue(photoScanTimeoutAction(null, { stage: "ordinary-qr", elapsedMs: 4100 }));
  const capture = vi.fn();
  render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={capture} onClose={vi.fn()} />);
  camera.options.video.srcObject = { getVideoTracks: () => [{ kind: "video", readyState: "live" }] };
  ready(); fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  await waitFor(() => expect(camera.scan).toHaveBeenCalled());
  expect(camera.scan.mock.calls[0][0]).toBe(pixels);
  expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 2000, 3000);
  expect((await screen.findByRole("alert")).textContent).toContain("Camera photo: 2000 × 3000");
  expect(screen.getByRole("alert").textContent).toContain("Last reported step: reading conventional QR codes (4.1 s into decoding).");
  expect(capture).not.toHaveBeenCalled();
  expect(camera.reset).toHaveBeenCalledTimes(1);
});

function canvasPixels() {
  const pixels = { width: 2000, height: 3000, data: new Uint8ClampedArray(4) };
  const context = { drawImage: vi.fn(), getImageData: vi.fn(() => pixels) };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  return { pixels, context };
}
function selectedPhoto({ width = 2000, height = 3000, decode = () => Promise.resolve() } = {}) {
  const image = { naturalWidth: width, naturalHeight: height, decode, src: "" };
  vi.stubGlobal("Image", vi.fn(function () { return image; }));
  URL.createObjectURL = vi.fn(() => "blob:synthetic-page");
  URL.revokeObjectURL = vi.fn();
  return image;
}
it.each(["unsupported", "too small", "rejected"])("never decodes the retake video when native capture is %s", async failure => {
  const { context } = canvasPixels();
  if (failure === "unsupported") vi.stubGlobal("ImageCapture", undefined);
  if (failure === "too small") createImageBitmap.mockResolvedValue({ width: 1200, height: 1600, close: vi.fn() });
  if (failure === "rejected") ImageCapture.mockImplementation(function () { return { takePhoto: () => Promise.reject(new Error("camera failed")) }; });
  render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={vi.fn()} onClose={vi.fn()} />);
  ready();
  await act(async () => camera.liveOptions.onCaptured({ captureOnly: true }));
  expect((await screen.findByRole("alert")).textContent).toContain("No video frame was scanned");
  expect(camera.scan).not.toHaveBeenCalled(); expect(camera.snapshot).not.toHaveBeenCalled();
  expect(camera.reset).not.toHaveBeenCalled();
  expect(context.drawImage).toHaveBeenCalledTimes(1); // Quality-preview only.
  expect(camera.liveScan.mock.calls[0][1]).toEqual({ captureOnly: true });
  expect(screen.getByRole("button", { name: "Capture now" }).disabled).toBe(false);
});
it("times out native retakes without decoding a video frame and ignores late camera pixels", async () => {
  vi.useFakeTimers();
  let finish;
  ImageCapture.mockImplementation(function () { return { takePhoto: () => new Promise(resolve => { finish = resolve; }) }; });
  const { context } = canvasPixels();
  const view = render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={vi.fn()} onClose={vi.fn()} />);
  ready(); fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByRole("alert").textContent).toContain("did not finish taking its photo in time");
  expect(camera.scan).not.toHaveBeenCalled();
  await act(async () => finish(new Blob()));
  expect(context.drawImage).toHaveBeenCalledTimes(1);
  view.unmount();
});
it("matches a selected high-resolution photo before replacing the page", async () => {
  const { pixels, context } = canvasPixels(), image = selectedPhoto();
  const capture = vi.fn(), file = new Blob(["replacement"]);
  camera.scan.mockResolvedValue({ status: "found", text: signed.seals[0] });
  camera.snapshot.mockResolvedValue(file);
  render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={capture} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Choose a high-resolution page photo"), { target: { files: [new File(["synthetic"], "page.jpg", { type: "image/jpeg" })] } });
  await waitFor(() => expect(capture).toHaveBeenCalledWith(file));
  expect(camera.scan.mock.calls[0][0]).toBe(pixels);
  expect(context.drawImage).toHaveBeenCalledWith(image, 0, 0, 2000, 3000);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-page");
  expect(ImageCapture).not.toHaveBeenCalled();
});
it("rejects a selected photo of a different authenticated page without replacing it", async () => {
  canvasPixels(); selectedPhoto();
  const other = await createQRedSeals({ content: "Different", privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=", publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=" });
  camera.scan.mockResolvedValue({ status: "found", text: other.seals[0] });
  const capture = vi.fn();
  render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={capture} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Choose a high-resolution page photo"), { target: { files: [new File(["synthetic"], "page.jpg")] } });
  expect((await screen.findByRole("alert")).textContent).toContain("does not match Page 2");
  expect(capture).not.toHaveBeenCalled(); expect(camera.snapshot).not.toHaveBeenCalled();
});
it("cancels a pending selected photo immediately, even before its dialog unmounts", async () => {
  const { context } = canvasPixels();
  let finish;
  selectedPhoto({ decode: () => new Promise(resolve => { finish = resolve; }) });
  const capture = vi.fn(), close = vi.fn();
  render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={capture} onClose={close} />);
  fireEvent.change(screen.getByLabelText("Choose a high-resolution page photo"), { target: { files: [new File(["synthetic"], "page.jpg")] } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel retake" }));
  await act(async () => finish());
  expect(close).toHaveBeenCalledTimes(1);
  expect(camera.scan).not.toHaveBeenCalled(); expect(context.drawImage).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled();
});
it("retries after unavailable native capture using an explicitly selected photo", async () => {
  canvasPixels(); selectedPhoto(); vi.stubGlobal("ImageCapture", undefined);
  camera.scan.mockResolvedValue({ status: "feedback", message: "No seal in this photo." });
  render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={vi.fn()} onClose={vi.fn()} />);
  ready(); fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  await screen.findByRole("alert");
  fireEvent.change(screen.getByLabelText("Choose a high-resolution page photo"), { target: { files: [new File(["synthetic"], "page.jpg")] } });
  await waitFor(() => expect(camera.scan).toHaveBeenCalledTimes(1));
  expect((await screen.findByRole("alert")).textContent).toContain("Selected photo: 2000 × 3000");
});

it("does not decode a selected retake below the document-photo resolution floor", async () => {
  const { context } = canvasPixels(); selectedPhoto({ width: 1200, height: 1600 });
  render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={vi.fn()} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Choose a high-resolution page photo"), { target: { files: [new File(["synthetic"], "small.jpg")] } });
  expect((await screen.findByRole("alert")).textContent).toContain("at least 4 MP and 2560 pixels");
  expect(camera.scan).not.toHaveBeenCalled(); expect(context.drawImage).not.toHaveBeenCalled();
});
it("replaces a pending file selection without reading or publishing its stale pixels", async () => {
  const { context } = canvasPixels();
  let finish;
  selectedPhoto();
  const oldImage = { naturalWidth: 2000, naturalHeight: 3000, decode: () => new Promise(resolve => { finish = resolve; }), src: "" };
  Image.mockImplementationOnce(function () { return oldImage; });
  camera.scan.mockResolvedValue({ status: "feedback", message: "Latest selected photo." });
  render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={vi.fn()} onClose={vi.fn()} />);
  const input = screen.getByLabelText("Choose a high-resolution page photo");
  fireEvent.change(input, { target: { files: [new File(["old"], "old.jpg")] } });
  fireEvent.change(input, { target: { files: [new File(["new"], "new.jpg")] } });
  await waitFor(() => expect(camera.scan).toHaveBeenCalledTimes(1));
  await act(async () => finish());
  expect(camera.scan).toHaveBeenCalledTimes(1);
  expect(context.drawImage).toHaveBeenCalledTimes(1);
  expect(context.drawImage.mock.calls[0][0]).not.toBe(oldImage);
  expect(screen.getByRole("alert").textContent).toContain("Latest selected photo.");
});
it("cancels a native retake before its uncancellable camera operation finishes", async () => {
  let finish;
  ImageCapture.mockImplementation(function () { return { takePhoto: () => new Promise(resolve => { finish = resolve; }) }; });
  const { context } = canvasPixels();
  render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={vi.fn()} onClose={vi.fn()} />);
  ready(); fireEvent.click(screen.getByRole("button", { name: "Capture now" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel retake" }));
  await act(async () => finish(new Blob()));
  expect(camera.scan).not.toHaveBeenCalled(); expect(createImageBitmap).not.toHaveBeenCalled();
  expect(context.drawImage).toHaveBeenCalledTimes(1); // Only the pre-capture quality preview.
});

it("resumes capture-only guidance after dismissing the retake photo picker", async () => {
  const { pixels, context } = canvasPixels();
  camera.scan.mockResolvedValue({ status: "feedback", message: "Native photo decoded." });
  render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={vi.fn()} onClose={vi.fn()} />);
  ready();
  fireEvent.click(screen.getByRole("button", { name: "Choose photo" }));
  act(() => camera.options.onFrame());
  expect(camera.liveScan).toHaveBeenCalledTimes(1);
  fireEvent(screen.getByLabelText("Choose a high-resolution page photo"), new Event("cancel"));
  expect(screen.getByRole("status").textContent).toContain("hold steady for automatic capture");
  expect(camera.reset).toHaveBeenCalledTimes(1);
  act(() => camera.options.onFrame());
  expect(camera.liveScan).toHaveBeenCalledTimes(2);
  expect(camera.liveScan.mock.calls.every(([, options]) => options.captureOnly === true)).toBe(true);
  expect(camera.scan).not.toHaveBeenCalled();
  expect(ImageCapture).not.toHaveBeenCalled();
  await act(async () => camera.liveOptions.onCaptured({ captureOnly: true }));
  expect(camera.scan).toHaveBeenCalledWith(pixels, expect.objectContaining({ returnPayload: true }));
  expect(ImageCapture).toHaveBeenCalledTimes(1);
  expect(context.drawImage.mock.calls.at(-1)[0]).toBe(await createImageBitmap.mock.results[0].value);
});
it.each(["close", "unmount", "camera error"])("does not resume retake guidance after picker dismissal following %s", action => {
  canvasPixels();
  const view = render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={vi.fn()} onClose={vi.fn()} />);
  ready();
  const picker = screen.getByLabelText("Choose a high-resolution page photo");
  fireEvent.click(screen.getByRole("button", { name: "Choose photo" }));
  if (action === "close") fireEvent.click(screen.getByRole("button", { name: "Cancel retake" }));
  if (action === "unmount") view.unmount();
  if (action === "camera error") act(() => camera.options.onError(new Error("Camera stopped")));
  fireEvent(picker, new Event("cancel"));
  expect(camera.reset).not.toHaveBeenCalled();
  expect(camera.scan).not.toHaveBeenCalled(); expect(ImageCapture).not.toHaveBeenCalled();
  if (action === "camera error") expect(screen.getByRole("alert").textContent).toContain("Camera stopped");
});
it("ignores a stale picker dismissal after a replacement file starts loading", async () => {
  canvasPixels();
  let finish;
  selectedPhoto({ decode: () => new Promise(resolve => { finish = resolve; }) });
  camera.scan.mockResolvedValue({ status: "feedback", message: "Selected photo decoded." });
  render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={vi.fn()} onClose={vi.fn()} />);
  ready();
  const picker = screen.getByLabelText("Choose a high-resolution page photo");
  fireEvent.click(screen.getByRole("button", { name: "Choose photo" }));
  fireEvent.change(picker, { target: { files: [new File(["synthetic"], "page.jpg")] } });
  expect(camera.reset).toHaveBeenCalledTimes(1);
  fireEvent(picker, new Event("cancel"));
  act(() => camera.options.onFrame());
  expect(camera.reset).toHaveBeenCalledTimes(1);
  expect(camera.liveScan).toHaveBeenCalledTimes(1);
  expect(camera.scan).not.toHaveBeenCalled(); expect(ImageCapture).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(camera.scan).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert").textContent).toContain("Selected photo decoded.");
});
it("resumes the pending camera after picker dismissal without opening another camera", () => {
  canvasPixels();
  render(<PageCameraCapture pageLabel="Page 2" seals={signed.seals} onCapture={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose photo" }));
  fireEvent(screen.getByLabelText("Choose a high-resolution page photo"), new Event("cancel"));
  expect(camera.reset).not.toHaveBeenCalled(); expect(camera.liveScan).not.toHaveBeenCalled();
  expect(camera.scan).not.toHaveBeenCalled(); expect(ImageCapture).not.toHaveBeenCalled();
  const pendingCamera = camera.options;
  ready();
  expect(camera.options).toBe(pendingCamera);
  expect(camera.liveScan).toHaveBeenCalledTimes(1);
  expect(camera.liveScan.mock.calls[0][1]).toEqual({ captureOnly: true });
  expect(camera.scan).not.toHaveBeenCalled(); expect(ImageCapture).not.toHaveBeenCalled();
});
