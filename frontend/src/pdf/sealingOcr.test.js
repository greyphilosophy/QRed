import { describe, expect, it, vi } from "vitest";
import { createSealingOcrReader, sealingOcrLines } from "./sealingOcr.js";
const line = { text: "Account 123", confidence: 92, bbox: { x0: 10, y0: 20, x1: 150, y1: 40 },
  words: [{ confidence: 94 }, { confidence: 35 }] };
const data = lines => ({ text: lines.map(line => line.text).join("\n"), blocks: [{ paragraphs: [{ lines }] }] });
describe("sealing OCR", () => {
  it("retains weak readings with bounded geometry and minimum token confidence", () => {
    expect(sealingOcrLines(data([line]), 200, 100)).toEqual([{ text: "Account 123", confidence: 35,
      x: 0.05, y: 0.2, width: 0.7, height: 0.2 }]);
  });
  it("never silently loses a transcript without geometry", () => {
    expect(() => sealingOcrLines({ text: "important amount", blocks: [] }, 200, 100)).toThrow(/positions/);
    expect(() => sealingOcrLines(data([{ ...line, bbox: null }]), 200, 100)).toThrow(/position/);
  });
  it("distinguishes an empty reading from a blank-page claim", () => {
    expect(sealingOcrLines({ text: "", blocks: [] }, 200, 100)).toEqual([]);
  });
  it("reuses one worker, uses no text hints/storage, and terminates it", async () => {
    const worker = { setParameters: vi.fn(), recognize: vi.fn().mockResolvedValue({ data: data([line]) }), terminate: vi.fn() };
    const factory = vi.fn().mockResolvedValue(worker);
    const reader = createSealingOcrReader({ workerFactory: factory });
    const image = new Uint8Array([1, 2]);
    await reader.read(image, 200, 100); await reader.read(image, 200, 100); await reader.dispose();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][2]).toMatchObject({ cacheMethod: "none" });
    expect(worker.recognize).toHaveBeenCalledWith(image, {}, { text: true, blocks: true });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it("terminates a worker that finishes loading after cancellation", async () => {
    const controller = new AbortController();
    let resolve;
    const worker = { terminate: vi.fn(), setParameters: vi.fn(), recognize: vi.fn() };
    const factory = vi.fn(() => new Promise(done => { resolve = done; }));
    const reader = createSealingOcrReader({ signal: controller.signal, workerFactory: factory });
    const pending = reader.read(new Uint8Array(), 200, 100);
    const assertion = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(factory).toHaveBeenCalled());
    controller.abort(); resolve(worker); await assertion; await reader.dispose();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(worker.recognize).not.toHaveBeenCalled();
  });
});

it("rejects promptly if cancellation terminates a worker without resolving recognition", async () => {
  const controller = new AbortController();
  const worker = { terminate: vi.fn(), setParameters: vi.fn(), recognize: vi.fn(() => new Promise(() => {})) };
  const reader = createSealingOcrReader({ signal: controller.signal, workerFactory: async () => worker });
  const pending = reader.read(new Uint8Array(), 200, 100);
  const assertion = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(worker.recognize).toHaveBeenCalled());
  controller.abort(); await assertion; await reader.dispose();
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it("rejects a partially missing transcript instead of signing only the located part", () => {
  expect(() => sealingOcrLines({ ...data([line]), text: "Account 123\nAmount 50.00" }, 200, 100)).toThrow(/complete line positions/);
});

it("cancels promptly while recognition assets are still loading", async () => {
  const controller = new AbortController();
  const factory = vi.fn(() => new Promise(() => {}));
  const reader = createSealingOcrReader({ signal: controller.signal, workerFactory: factory });
  const pending = reader.read(new Uint8Array(), 200, 100);
  const assertion = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(factory).toHaveBeenCalled());
  controller.abort(); await assertion; await reader.dispose();
});

it("uses only versioned same-origin recognition assets in the browser", async () => {
  vi.stubEnv("SSR", false);
  const worker = { setParameters: vi.fn(), recognize: vi.fn().mockResolvedValue({ data: data([line]) }), terminate: vi.fn() };
  const factory = vi.fn().mockResolvedValue(worker);
  const reader = createSealingOcrReader({ workerFactory: factory });
  try {
    await reader.read("data:image/png;base64,AA==", 200, 100);
    expect(factory.mock.calls[0][2]).toMatchObject({ workerPath: "/ocr/v1/worker.min.js",
      corePath: "/ocr/v1", langPath: "/ocr/v1", workerBlobURL: false, cacheMethod: "none" });
  } finally { await reader.dispose(); vi.unstubAllEnvs(); }
});
