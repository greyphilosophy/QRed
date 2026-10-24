/* @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createQRedSeals } from "../qredSealer.js";
import { decodeSeal } from "../qredVerifier.js";
import { createScanPhotoCollection, MAX_SCAN_PHOTO_BYTES, MAX_SCAN_PHOTOS, snapshotScanPhoto } from "./scanPhotos.js";

let seals, others;
const frame = { width: 1200, height: 1600 };
beforeAll(async () => {
  vi.stubGlobal("crypto", webcrypto);
  const keys = { privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=", publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=" };
  ({ seals } = await createQRedSeals({ ...keys, content: "A".repeat(3000), encodingStrategy: "plaintext" }));
  others = await Promise.all(Array.from({ length: MAX_SCAN_PHOTOS + 1 }, async (_, i) =>
    (await createQRedSeals({ ...keys, content: `Synthetic page ${i}` })).seals[0]));
});
afterEach(() => vi.restoreAllMocks());

it("associates original scan images by page and seal, with no duplicate work", async () => {
  const changed = vi.fn(), snapshot = vi.fn(async () => new Blob(["pixels"], { type: "image/png" }));
  const collection = createScanPhotoCollection(changed, snapshot);
  await Promise.all([collection.capture(seals[1], frame), collection.capture(seals[1], frame)]);
  await collection.capture(others[0], frame);
  await collection.capture(seals[0], frame);
  await collection.capture("https://qred.org/", frame);
  await collection.capture(seals[0], frame);
  expect(snapshot).toHaveBeenCalledTimes(3);
  expect(snapshot).toHaveBeenCalledWith(frame);
  expect(changed.mock.lastCall[0].photos.map(({ documentId, chunkNumber }) => [documentId, chunkNumber])).toEqual([
    [decodeSeal(seals[1]).document_id, 1], [decodeSeal(others[0]).document_id, 0], [decodeSeal(seals[0]).document_id, 0],
  ]);
});

it("drops late encodings after clearing without blocking a new scan of the same seal", async () => {
  const resolve = [], changed = vi.fn();
  const collection = createScanPhotoCollection(changed, () => new Promise(done => resolve.push(done)));
  const old = collection.capture(seals[0], frame);
  collection.clear();
  const next = collection.capture(seals[0], frame);
  resolve[0]({ size: 1 }); await old;
  expect(changed.mock.lastCall[0].photos).toEqual([]);
  resolve[1]({ size: 2 }); await next;
  expect(changed.mock.lastCall[0].photos).toHaveLength(1);
  expect(changed.mock.lastCall[0].photos[0].file.size).toBe(2);
});

it("reports failed image capture without rejecting the seal or preventing retry", async () => {
  const changed = vi.fn(), snapshot = vi.fn().mockRejectedValueOnce(new Error("No canvas"))
    .mockResolvedValue({ size: 100 });
  const collection = createScanPhotoCollection(changed, snapshot);
  await expect(collection.capture(seals[0], frame)).resolves.toBeUndefined();
  expect(changed.mock.lastCall[0]).toMatchObject({ photos: [], notice: expect.stringContaining("seal is still collected") });
  await collection.capture(seals[0], frame);
  expect(changed.mock.lastCall[0].photos).toHaveLength(1);
});

it.each([1, MAX_SCAN_PHOTO_BYTES / 2])("bounds retained image count and bytes (image size %s)", async size => {
  const changed = vi.fn();
  const collection = createScanPhotoCollection(changed, async () => ({ size }));
  for (const seal of others) await collection.capture(seal, frame);
  const { photos, notice } = changed.mock.lastCall[0];
  expect(photos.length).toBeLessThanOrEqual(MAX_SCAN_PHOTOS);
  expect(photos.reduce((sum, photo) => sum + photo.file.size, 0)).toBeLessThanOrEqual(MAX_SCAN_PHOTO_BYTES);
  expect(photos.at(-1).documentId).toBe(decodeSeal(others.at(-1)).document_id);
  expect(notice).toContain("Older scan images were released");
  collection.clear();
  expect(changed.mock.lastCall[0]).toEqual({ photos: [], notice: "" });
});

it("copies the unfiltered source synchronously, caps pixels, and releases the temporary canvas", async () => {
  const context = { fillRect: vi.fn(), drawImage: vi.fn() };
  let encoded, copy;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function(callback, type) {
    copy = this; encoded = callback; expect(type).toBe("image/png");
  });
  const source = document.createElement("canvas"); source.width = 6000; source.height = 4000;
  const pending = snapshotScanPhoto(source);
  expect(copy).not.toBe(source);
  expect(context.drawImage).toHaveBeenCalledWith(source, 0, 0, 3000, 2000);
  expect(copy.width * copy.height).toBe(6_000_000);
  const blob = new Blob(["original pixels"]); encoded(blob);
  await expect(pending).resolves.toBe(blob);
  expect(copy.width * copy.height).toBe(0);
  expect(source.width).toBe(6000);
});
