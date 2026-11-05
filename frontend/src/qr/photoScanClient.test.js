/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLiveScanWorker, scanPhotoInWorker, preparePhotoReadingInWorker } from "./photoScanClient.js";

let worker;
beforeEach(() => {
  worker = { postMessage: vi.fn(), terminate: vi.fn() };
  vi.stubGlobal("Worker", vi.fn(function () { return worker; }));
});
afterEach(() => vi.unstubAllGlobals());
const image = () => ({ data: new Uint8ClampedArray(24), width: 2, height: 3 });

it("cancels background OCR preparation and ignores its late result", async () => {
  const controller = new AbortController(), pixels = image();
  const pending = preparePhotoReadingInWorker(pixels, { signal: controller.signal });
  expect(worker.postMessage).toHaveBeenCalledWith({ image: pixels, prepareReading: true }, [pixels.data.buffer]);
  const late = worker.onmessage;
  controller.abort();
  late({ data: { action: { image: pixels, codes: [] } } });
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

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

it("acknowledges capture without releasing the frozen frame, and ignores a cancelled acknowledgement", () => {
  const onCaptured = vi.fn(), onResult = vi.fn(), onQuality = vi.fn();
  const live = createLiveScanWorker({ onCaptured, onResult, onQuality, onError: vi.fn(), requirePageQuality: true });
  live.scan(image());
  const receive = worker.onmessage, quality = { ready: true, state: "ready" };
  receive({ data: { captured: true, quality } });
  expect(onCaptured).toHaveBeenCalledTimes(1);
  expect(onQuality).toHaveBeenCalledWith(quality);
  expect(onResult).not.toHaveBeenCalled();
  expect(live.busy).toBe(true);
  expect(live.scan(image())).toBe(false);
  live.reset();
  receive({ data: { captured: true, quality } });
  receive({ data: { action: { status: "found", text: "late" } } });
  expect(onCaptured).toHaveBeenCalledTimes(1);
  expect(onResult).not.toHaveBeenCalled();
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

it("preserves the live worker's movement gate when handing off a native still capture", () => {
  const onCaptured = vi.fn(), onResult = vi.fn();
  const live = createLiveScanWorker({ onCaptured, onResult, onError: vi.fn(), requirePageQuality: true });
  live.scan(image(), { captureOnly: true });
  expect(worker.postMessage.mock.calls[0][0].captureOnly).toBe(true);
  worker.onmessage({ data: { captured: true, captureOnly: true, quality: { ready: true } } });
  expect(onCaptured).toHaveBeenCalledWith({ captureOnly: true });
  expect(live.busy).toBe(false);
  expect(onResult).not.toHaveBeenCalled();
  expect(worker.terminate).not.toHaveBeenCalled();
  live.scan(image(), { captureOnly: true });
  expect(Worker).toHaveBeenCalledTimes(1);
  live.stop();
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

it("terminates an unresponsive photo at the deadline and ignores queued success", async () => {
  vi.useFakeTimers();
  try {
    const pending = scanPhotoInWorker(image());
    const late = worker.onmessage;
    vi.advanceTimersByTime(7999);
    expect(worker.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await expect(pending).resolves.toMatchObject({ status: "feedback", timedOut: true });
    late({ data: { action: { status: "found", text: "late" } } });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("checkpoints partial chunks without settling or extending the deadline", async () => {
  vi.useFakeTimers();
  try {
    const settled = vi.fn();
    const pending = scanPhotoInWorker(image()).then(settled);
    vi.advanceTimersByTime(7000);
    worker.onmessage({ data: { progress: { status: "found-multiple", texts: ["first", "second"] } } });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(worker.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    await pending;
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ status: "found-multiple", texts: ["first", "second"], timedOut: true }));
  } finally { vi.useRealTimers(); }
});

it("keeps concurrent photo deadlines and partials independent", async () => {
  vi.useFakeTimers();
  try {
    const first = worker, second = { postMessage: vi.fn(), terminate: vi.fn() };
    Worker.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const one = scanPhotoInWorker(image());
    first.onmessage({ data: { progress: { status: "found-multiple", texts: ["first"] } } });
    vi.advanceTimersByTime(4000);
    const two = scanPhotoInWorker(image());
    vi.advanceTimersByTime(4000);
    await expect(one).resolves.toMatchObject({ texts: ["first"], timedOut: true });
    expect(second.terminate).not.toHaveBeenCalled();
    second.onmessage({ data: { action: { status: "found", text: "second" } } });
    await expect(two).resolves.toEqual({ status: "found", text: "second" });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it.each(["success", "cancel", "load", "message", "decode", "transfer"])("clears the photo deadline after %s", async kind => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    if (kind === "transfer") worker.postMessage.mockImplementation(() => { throw new Error("transfer failed"); });
    const pending = scanPhotoInWorker(image(), { signal: controller.signal });
    if (kind === "success") worker.onmessage({ data: { action: { status: "found", text: "on time" } } });
    if (kind === "cancel") controller.abort();
    if (kind === "load") worker.onerror({ preventDefault: vi.fn() });
    if (kind === "message") worker.onmessageerror();
    if (kind === "decode") worker.onmessage({ data: { error: "Invalid photo" } });
    if (kind === "success") await expect(pending).resolves.toMatchObject({ text: "on time" });
    else if (kind === "cancel") await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    else await expect(pending).rejects.toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(9000);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it("does not apply the seal-reading deadline to OCR preparation", async () => {
  vi.useFakeTimers();
  try {
    const pending = preparePhotoReadingInWorker(image());
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(9000);
    expect(worker.terminate).not.toHaveBeenCalled();
    const action = { image: image(), codes: [] };
    worker.onmessage({ data: { action } });
    await expect(pending).resolves.toEqual(action);
  } finally { vi.useRealTimers(); }
});

it("bounds a captured live photo, preserves chunks, and requires reset before recapture", () => {
  vi.useFakeTimers();
  try {
    const onResult = vi.fn(), onError = vi.fn();
    const live = createLiveScanWorker({ onResult, onError, requirePageQuality: true });
    live.scan(image());
    const late = worker.onmessage;
    worker.onmessage({ data: { captured: true, quality: { ready: true } } });
    worker.onmessage({ data: { progress: { status: "found-multiple", texts: ["partial"] } } });
    vi.advanceTimersByTime(8000);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(live.busy).toBe(false);
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ texts: ["partial"], timedOut: true }));
    expect(live.scan(image())).toBe(false);
    late({ data: { action: { status: "found", text: "late" } } });
    expect(onResult).toHaveBeenCalledTimes(1);
    live.reset();
    const second = { postMessage: vi.fn(), terminate: vi.fn() };
    Worker.mockReturnValueOnce(second);
    expect(live.scan(image())).toBe(true);
    second.onmessage({ data: { captured: true, quality: { ready: true } } });
    second.onmessage({ data: { action: { status: "found", text: "fresh" } } });
    expect(onResult).toHaveBeenLastCalledWith({ status: "found", text: "fresh" });
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    live.stop();
  } finally { vi.useRealTimers(); }
});

it.each(["reset", "stop", "result", "error"])("clears a captured live deadline on %s", kind => {
  vi.useFakeTimers();
  try {
    const onResult = vi.fn(), onError = vi.fn();
    const live = createLiveScanWorker({ onResult, onError });
    live.scan(image());
    worker.onmessage({ data: { captured: true } });
    expect(vi.getTimerCount()).toBe(1);
    if (kind === "reset") live.reset();
    if (kind === "stop") live.stop();
    if (kind === "result") worker.onmessage({ data: { action: { status: "continue" } } });
    if (kind === "error") worker.onerror({ preventDefault: vi.fn() });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(9000);
    expect(onResult).toHaveBeenCalledTimes(kind === "result" ? 1 : 0);
    live.stop();
  } finally { vi.useRealTimers(); }
});

it("does not start a captured-photo deadline for native still handoff", () => {
  vi.useFakeTimers();
  try {
    const live = createLiveScanWorker({ onResult: vi.fn(), onError: vi.fn(), requirePageQuality: true });
    live.scan(image(), { captureOnly: true });
    worker.onmessage({ data: { captured: true, captureOnly: true, quality: { ready: true } } });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(9000);
    expect(worker.terminate).not.toHaveBeenCalled();
    live.stop();
  } finally { vi.useRealTimers(); }
});

it("retains the last safe stage without settling, extending the deadline, or losing chunks", async () => {
  vi.useFakeTimers();
  try {
    const settled = vi.fn();
    const pending = scanPhotoInWorker(image()).then(settled);
    const receive = worker.onmessage;
    receive({ data: { scanStage: { stage: "rectified-fast", elapsedMs: 0 } } });
    vi.advanceTimersByTime(7000);
    receive({ data: { scanStage: { stage: "ordinary-qr", elapsedMs: 6900, secret: "private" } } });
    receive({ data: { scanStage: { stage: "private", elapsedMs: 7000 } } });
    receive({ data: { progress: { status: "found-multiple", texts: ["partial"] } } });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    await pending;
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ timedOut: true, texts: ["partial"],
      scanDiagnostic: { stage: "ordinary-qr", elapsedMs: 6900 } }));
    expect(settled.mock.calls[0][0].message).not.toContain("private");
    receive({ data: { scanStage: { stage: "footer", elapsedMs: 9000 } } });
    expect(settled).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it("keeps stage diagnostics local to each photo request", async () => {
  vi.useFakeTimers();
  try {
    const first = worker, second = { postMessage: vi.fn(), terminate: vi.fn() };
    Worker.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const one = scanPhotoInWorker(image()), two = scanPhotoInWorker(image());
    first.onmessage({ data: { scanStage: { stage: "footer", elapsedMs: 100 } } });
    vi.advanceTimersByTime(8000);
    await expect(one).resolves.toMatchObject({ scanDiagnostic: { stage: "footer", elapsedMs: 100 } });
    expect(await two).not.toHaveProperty("scanDiagnostic");
  } finally { vi.useRealTimers(); }
});

it("clears a live scan's stage metadata on reset", () => {
  vi.useFakeTimers();
  try {
    const onResult = vi.fn();
    const live = createLiveScanWorker({ onResult, onError: vi.fn() });
    live.scan(image());
    worker.onmessage({ data: { captured: true } });
    worker.onmessage({ data: { scanStage: { stage: "footer", elapsedMs: 500 } } });
    vi.advanceTimersByTime(8000);
    expect(onResult.mock.calls[0][0].scanDiagnostic).toEqual({ stage: "footer", elapsedMs: 500 });
    live.reset();
    worker = { postMessage: vi.fn(), terminate: vi.fn() };
    Worker.mockReturnValueOnce(worker);
    live.scan(image());
    worker.onmessage({ data: { captured: true } });
    vi.advanceTimersByTime(8000);
    expect(onResult.mock.calls[1][0]).not.toHaveProperty("scanDiagnostic");
    live.stop();
  } finally { vi.useRealTimers(); }
});
