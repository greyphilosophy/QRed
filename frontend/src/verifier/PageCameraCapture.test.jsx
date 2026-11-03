/* @vitest-environment jsdom */
/* eslint-disable no-unused-vars */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createQRedSeals } from "../qredSealer.js";
import { qrPayloadBytes, sealString } from "../sealFormat.js";
import { decodeSeal } from "../qredVerifier.js";
import { PageCameraCapture, confirmsPageSeal } from "./PageCameraCapture.jsx";

const camera = vi.hoisted(() => ({ stop: vi.fn(), options: null, snapshot: vi.fn(), scan: vi.fn(), reset: vi.fn(), liveOptions: null }));
vi.mock("../qr/cameraSession.js", () => ({ startCameraSession: options => { camera.options = options; return { stop: camera.stop }; } }));
vi.mock("../qr/photoScanClient.js", () => ({ scanPhotoInWorker: camera.scan, createLiveScanWorker: options => {
  camera.liveOptions = options;
  return { busy: false, scan: vi.fn(), reset: camera.reset, stop: vi.fn() };
} }));
vi.mock("./scanPhotos.js", () => ({ snapshotScanPhoto: camera.snapshot }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });
const signed = await createQRedSeals({ content: "Friday", privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=",
  publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=" });
function ready() {
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
it("captures through the browser stream and releases the canvas and camera without saving a file", async () => {
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
  expect(view.container.querySelector("input[type=file]")).toBeNull();
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
