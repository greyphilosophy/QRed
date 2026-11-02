/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLiveScanWorker, scanPhotoInWorker } from "./photoScanClient.js";

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

it("keeps one live frame in flight without queuing older frames, and reuses the worker", () => {
  const onResult = vi.fn(), onError = vi.fn();
  const live = createLiveScanWorker({ onResult, onError, returnPayload: true });
  const first = image(), ignored = image(), latest = image();
  expect(live.scan(first)).toBe(true);
  expect(live.busy).toBe(true);
  expect(live.scan(ignored)).toBe(false);
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  expect(worker.postMessage).toHaveBeenCalledWith({ image: first, returnPayload: true, live: true }, [first.data.buffer]);
  const action = { status: "found-multiple", texts: ["one", "two", "three", "four"] };
  worker.onmessage({ data: { action } });
  expect(onResult).toHaveBeenCalledWith(action);
  expect(live.busy).toBe(false);
  expect(live.scan(latest)).toBe(true);
  expect(worker.postMessage).toHaveBeenLastCalledWith({ image: latest, returnPayload: true, live: true }, [latest.data.buffer]);
  expect(Worker).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
  live.stop();
});

it("discards a live result on reset, then starts a fresh worker without reviving the old frame", () => {
  const first = worker, second = { postMessage: vi.fn(), terminate: vi.fn() };
  Worker.mockReturnValueOnce(first).mockReturnValueOnce(second);
  const onResult = vi.fn(), onError = vi.fn();
  const live = createLiveScanWorker({ onResult, onError });
  live.scan(image());
  const late = first.onmessage;
  live.reset();
  expect(first.terminate).toHaveBeenCalledTimes(1);
  expect(live.busy).toBe(false);
  live.scan(image());
  late({ data: { action: { status: "found", text: "stale" } } });
  expect(live.busy).toBe(true);
  expect(onResult).not.toHaveBeenCalled();
  second.onmessage({ data: { action: { status: "continue" } } });
  expect(onResult).toHaveBeenCalledTimes(1);
  expect(onResult).toHaveBeenCalledWith({ status: "continue" });
  live.stop();
});

it("requests quality checks on the submitted frame and reports guidance before its seal result", () => {
  const order = [], onQuality = vi.fn(() => order.push("quality")), onResult = vi.fn(() => order.push("seal"));
  const live = createLiveScanWorker({ onQuality, onResult, onError: vi.fn(), requirePageQuality: true });
  const frame = image();
  live.scan(frame);
  expect(worker.postMessage.mock.calls[0][0]).toMatchObject({ image: frame, requirePageQuality: true, frameTime: expect.any(Number) });
  const quality = { state: "framing", ready: false, corners: null }, action = { status: "continue" };
  worker.onmessage({ data: { quality, action } });
  expect(onQuality).toHaveBeenCalledWith(quality);
  expect(onResult).toHaveBeenCalledWith(action);
  expect(order).toEqual(["quality", "seal"]);
  live.stop();
});

it("stops a live session permanently and ignores its queued result", () => {
  const onResult = vi.fn();
  const live = createLiveScanWorker({ onResult, onError: vi.fn() });
  live.scan(image());
  const late = worker.onmessage;
  live.stop(); live.stop();
  late({ data: { action: { status: "found", text: "stale" } } });
  expect(onResult).not.toHaveBeenCalled();
  expect(live.scan(image())).toBe(false);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it.each(["decode", "load", "message", "transfer"])("stops live decoding on a %s error", kind => {
  const onError = vi.fn(), onResult = vi.fn();
  const live = createLiveScanWorker({ onResult, onError });
  if (kind === "transfer") worker.postMessage.mockImplementation(() => { throw new Error("transfer failed"); });
  live.scan(image());
  if (kind === "decode") worker.onmessage({ data: { error: "Invalid frame" } });
  if (kind === "load") worker.onerror({ preventDefault: vi.fn() });
  if (kind === "message") worker.onmessageerror();
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onResult).not.toHaveBeenCalled();
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(live.scan(image())).toBe(false);
});
