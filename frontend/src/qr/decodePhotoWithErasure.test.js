import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { decodePhotoWithErasure } from "./decodePhotoWithErasure.js";
import { decodePhoto } from "./decodePhoto.js";
import { scanErasureSeals } from "./scanErasureSeals.js";

vi.mock("./decodePhoto.js", () => ({ decodePhoto: vi.fn() }));
vi.mock("./scanErasureSeals.js", async original => ({ ...await original(), scanErasureSeals: vi.fn() }));
const image = () => ({ width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4).fill(255) });
beforeEach(() => {
  decodePhoto.mockReset().mockReturnValue({ status: "feedback", message: "Retake." });
  scanErasureSeals.mockReset().mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

it("charges asynchronous discovery to the same overall photo deadline", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  scanErasureSeals.mockImplementation(async (_image, { shouldContinue }) => {
    now = 1999; expect(shouldContinue()).toBe(true);
    now = 2000; expect(shouldContinue()).toBe(false);
    return [];
  });
  const original = image();
  await decodePhotoWithErasure(original, { returnPayload: true });
  expect(decodePhoto).toHaveBeenCalledWith(original, { returnPayload: true, maxDurationMs: 6000 });
});

it("reserves three quarters of a shorter budget for legacy compatibility", async () => {
  let now = 10;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  scanErasureSeals.mockImplementation(async (_image, { shouldContinue }) => {
    now = 260; expect(shouldContinue()).toBe(false);
    return [];
  });
  const original = image();
  await decodePhotoWithErasure(original, { returnPayload: true, maxDurationMs: 1000 });
  expect(decodePhoto).toHaveBeenCalledWith(original, { returnPayload: true, maxDurationMs: 750 });
});

it("caps caller-supplied durations and never restarts an exhausted deadline", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  scanErasureSeals.mockImplementation(async () => { now = 8001; return []; });
  expect(await decodePhotoWithErasure(image(), { returnPayload: true, maxDurationMs: 1e9 })).toMatchObject({ status: "feedback" });
  expect(decodePhoto).not.toHaveBeenCalled();
});

it("preserves the generic non-payload decoder without QRE work", async () => {
  vi.spyOn(performance, "now").mockReturnValue(0);
  decodePhoto.mockReturnValue({ status: "found", text: "ordinary QR text" });
  const original = image();
  expect(await decodePhotoWithErasure(original)).toEqual({ status: "found", text: "ordinary QR text" });
  expect(decodePhoto).toHaveBeenCalledWith(original, { returnPayload: false, maxDurationMs: 8000 });
  expect(scanErasureSeals).not.toHaveBeenCalled();
});

it("passes only reduced discovery pixels to QRE and keeps the original for legacy recovery", async () => {
  const original = { width: 2000, height: 2000, data: new Uint8ClampedArray(16_000_000).fill(255) };
  await decodePhotoWithErasure(original, { returnPayload: true });
  const scanned = scanErasureSeals.mock.calls[0][0];
  expect(scanned.width * scanned.height).toBeLessThanOrEqual(2_000_000);
  expect(scanned.data.buffer).not.toBe(original.data.buffer);
  expect(decodePhoto.mock.calls[0][0]).toBe(original);
});

it("rejects cancellation and malformed byte buffers before either scanner starts", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(decodePhotoWithErasure(image(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  await expect(decodePhotoWithErasure({ width: 1, height: 1, data: { length: 4 } }, { returnPayload: true })).rejects.toThrow(/smaller photo/);
  expect(decodePhoto).not.toHaveBeenCalled(); expect(scanErasureSeals).not.toHaveBeenCalled();
});
