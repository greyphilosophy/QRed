/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { scanPhotoInWorker } from "./photoScanClient.js";

let worker;
beforeEach(() => {
  worker = { postMessage: vi.fn(), terminate: vi.fn() };
  vi.stubGlobal("Worker", vi.fn(function () { return worker; }));
});
afterEach(() => vi.unstubAllGlobals());
const image = () => ({ data: new Uint8ClampedArray(24), width: 2, height: 3 });

it("transfers the original pixel buffer and terminates after returning all page chunks", async () => {
  const pixels = image();
  const pending = scanPhotoInWorker(pixels, { returnPayload: true });
  expect(worker.postMessage).toHaveBeenCalledWith({ image: pixels, returnPayload: true }, [pixels.data.buffer]);
  const action = { status: "found-multiple", texts: ["first", "second", "third", "fourth"] };
  worker.onmessage({ data: { action } });
  await expect(pending).resolves.toEqual(action);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it("terminates on cancellation and ignores any queued result", async () => {
  const controller = new AbortController();
  const pending = scanPhotoInWorker(image(), { signal: controller.signal });
  const queuedResult = worker.onmessage;
  controller.abort();
  queuedResult({ data: { action: { status: "found", text: "stale" } } });
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(worker.onmessage).toBeNull();
});

it("does not start a worker for an already cancelled scan", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(scanPhotoInWorker(image(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(Worker).not.toHaveBeenCalled();
});

it.each(["decode", "load", "message", "transfer"])("releases the worker on a %s error", async kind => {
  if (kind === "transfer") worker.postMessage.mockImplementation(() => { throw new Error("transfer failed"); });
  const pending = scanPhotoInWorker(image());
  if (kind === "decode") worker.onmessage({ data: { error: "Invalid photo" } });
  if (kind === "load") worker.onerror({ preventDefault: vi.fn() });
  if (kind === "message") worker.onmessageerror();
  await expect(pending).rejects.toBeInstanceOf(Error);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});
