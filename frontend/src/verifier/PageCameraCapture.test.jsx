/* @vitest-environment jsdom */
/* eslint-disable no-unused-vars */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PageCameraCapture } from "./PageCameraCapture.jsx";

const camera = vi.hoisted(() => ({ stop: vi.fn(), options: null, snapshot: vi.fn() }));
vi.mock("../qr/cameraSession.js", () => ({ startCameraSession: options => { camera.options = options; return { stop: camera.stop }; } }));
vi.mock("./scanPhotos.js", () => ({ snapshotScanPhoto: camera.snapshot }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });
function ready() {
  Object.defineProperties(camera.options.video, { videoWidth: { value: 800 }, videoHeight: { value: 1000 } });
  act(() => camera.options.onFrame());
}
it("captures through the browser stream and releases the canvas and camera without saving a file", async () => {
  const file = new Blob(["temporary pixels"], { type: "image/png" }), capture = vi.fn(), close = vi.fn();
  camera.snapshot.mockResolvedValue(file);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() });
  const storage = vi.spyOn(Storage.prototype, "setItem"), download = vi.spyOn(HTMLAnchorElement.prototype, "click");
  const view = render(<PageCameraCapture pageLabel="Page 2" onCapture={capture} onClose={close} />);
  ready(); fireEvent.click(screen.getByRole("button", { name: "Use this view" }));
  await waitFor(() => expect(capture).toHaveBeenCalledWith(file));
  expect(camera.stop).toHaveBeenCalled(); expect(close).toHaveBeenCalled();
  expect(camera.snapshot.mock.calls[0][0].width).toBe(0);
  expect(view.container.querySelector("input[type=file]")).toBeNull();
  expect(storage).not.toHaveBeenCalled(); expect(download).not.toHaveBeenCalled();
});
it("discards a retake that finishes after the session is closed", async () => {
  let finish;
  camera.snapshot.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() });
  const capture = vi.fn(), view = render(<PageCameraCapture pageLabel="Page 2" onCapture={capture} onClose={vi.fn()} />);
  ready(); fireEvent.click(screen.getByRole("button", { name: "Use this view" }));
  view.unmount(); await act(async () => finish(new Blob(["late"])));
  expect(capture).not.toHaveBeenCalled(); expect(camera.stop).toHaveBeenCalled();
});
