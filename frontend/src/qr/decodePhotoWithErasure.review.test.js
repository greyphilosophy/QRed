import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { createQRedSeals } from "../qredSealer.js";
import { encodeErasureChunks } from "../erasureTransport.js";
import { qrPayloadBytes, qrPayloadText } from "../sealFormat.js";
import { decodeSeal, verifyQRedSeals } from "../qredVerifier.js";
import { verifySealCollection } from "../sealCollection.js";
import { decodePhotoWithErasure } from "./decodePhotoWithErasure.js";
import { scanErasureSeals } from "./scanErasureSeals.js";
import { decodePhoto } from "./decodePhoto.js";

vi.mock("./scanErasureSeals.js", async original => ({ ...await original(), scanErasureSeals: vi.fn() }));
vi.mock("./decodePhoto.js", () => ({ decodePhoto: vi.fn() }));
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";
const otherKey = "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI";
let first, second, legacy;
const photo = () => ({ width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4).fill(255) });
const actionTexts = action => action.status === "found" ? [action.text] : action.texts || [];

beforeAll(async () => {
  const options = { privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=", publicKey,
    timestamp: "2026-11-01T12:00:00Z", pageContext: { pageNumber: 1, pageCount: 1 } };
  const a = await createQRedSeals({ ...options, content: "Review first page, total 50.00." });
  const b = await createQRedSeals({ ...options, content: "Review second page, total 80.00." });
  legacy = b.seals[0];
  first = (await encodeErasureChunks(qrPayloadBytes(a.seals[0]))).map(qrPayloadText);
  second = (await encodeErasureChunks(qrPayloadBytes(b.seals[0]))).map(qrPayloadText);
});
beforeEach(() => {
  scanErasureSeals.mockReset().mockResolvedValue([]);
  decodePhoto.mockReset().mockReturnValue({ status: "feedback", message: "Retake." });
});
afterEach(() => vi.restoreAllMocks());

it("collects twelve distinct QRE shards but still requires the trusted signing key", async () => {
  scanErasureSeals.mockResolvedValue(first.slice(0, 12));
  const action = await decodePhotoWithErasure(photo(), { returnPayload: true });
  expect(actionTexts(action)).toEqual(first.slice(0, 12));
  expect(decodePhoto).not.toHaveBeenCalled();
  expect((await verifyQRedSeals(actionTexts(action), publicKey)).status).toBe("VALID");
  expect((await verifyQRedSeals(actionTexts(action), otherKey)).status).toBe("INVALID");
  expect(action).not.toHaveProperty("signature_valid");
});

it("does not count repeated observations toward the erasure threshold", async () => {
  scanErasureSeals.mockResolvedValue([...first.slice(0, 11), first[0], first[0]]);
  const image = photo(), before = image.data.slice();
  const action = await decodePhotoWithErasure(image, { returnPayload: true });
  expect(decodePhoto).toHaveBeenCalledTimes(1);
  expect(decodePhoto.mock.calls[0][0]).toBe(image);
  expect(actionTexts(action)).toEqual(first.slice(0, 11));
  expect((await verifyQRedSeals(actionTexts(action), publicKey)).status).toBe("INCOMPLETE");
  expect(image.data).toEqual(before);
});

it("never completes an eleven-shard group using twelve shards from another record", async () => {
  const observed = [...first.slice(0, 11), ...second.slice(0, 12)];
  scanErasureSeals.mockResolvedValue(observed);
  const action = await decodePhotoWithErasure(photo(), { returnPayload: true });
  expect(decodePhoto).toHaveBeenCalledTimes(1);
  expect(actionTexts(action)).toEqual(observed);
  const results = await verifySealCollection(actionTexts(action), publicKey);
  expect(results.map(result => result.status)).toEqual(["INCOMPLETE", "VALID"]);
});

it("retains a conflicting duplicate instead of hiding it behind a complete group", async () => {
  const corrupt = qrPayloadBytes(first[0]).slice(); corrupt[corrupt.length - 1] ^= 1;
  const changed = qrPayloadText(corrupt);
  expect(decodeSeal(changed).document_id).toBe(decodeSeal(first[0]).document_id);
  scanErasureSeals.mockResolvedValue([...first.slice(0, 12), changed]);
  const texts = actionTexts(await decodePhotoWithErasure(photo(), { returnPayload: true }));
  expect(texts).toContain(first[0]); expect(texts).toContain(changed);
  expect((await verifyQRedSeals(texts, publicKey)).status).toBe("INVALID");
});

it("retains corrupt extra parity and cannot authenticate a favorable twelve-shard subset", async () => {
  const corrupt = qrPayloadBytes(first[12]).slice(); corrupt[corrupt.length - 1] ^= 1;
  const changed = qrPayloadText(corrupt);
  scanErasureSeals.mockResolvedValue([...first.slice(0, 12), changed]);
  const texts = actionTexts(await decodePhotoWithErasure(photo(), { returnPayload: true }));
  expect(texts).toHaveLength(13);
  expect(await verifyQRedSeals(texts, publicKey)).toMatchObject({ status: "ERROR", error_message: expect.stringContaining("Conflicting erasure parity") });
});

it("preserves partial QRE observations when legacy decoding finds a different complete seal", async () => {
  scanErasureSeals.mockResolvedValue(first.slice(0, 3));
  decodePhoto.mockReturnValue({ status: "found", text: legacy });
  const texts = actionTexts(await decodePhotoWithErasure(photo(), { returnPayload: true }));
  expect(new Set(texts)).toEqual(new Set([...first.slice(0, 3), legacy]));
  expect((await verifySealCollection(texts, publicKey)).map(result => result.status).sort()).toEqual(["INCOMPLETE", "VALID"]);
});

it("does not emit a stale complete result if cancelled while the QRE scan resolves", async () => {
  const controller = new AbortController();
  scanErasureSeals.mockImplementation(async () => { controller.abort(); return first.slice(0, 12); });
  await expect(decodePhotoWithErasure(photo(), { returnPayload: true, signal: controller.signal }))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(decodePhoto).not.toHaveBeenCalled();
});

it("does not spend decode work when the deadline is already exhausted", async () => {
  const action = await decodePhotoWithErasure(photo(), { returnPayload: true, maxDurationMs: 0 });
  expect(action.status).toBe("feedback");
  expect(scanErasureSeals).not.toHaveBeenCalled();
  expect(decodePhoto).not.toHaveBeenCalled();
});

it.each([NaN, Infinity, -Infinity])("rejects a nonfinite duration %s without invoking scanners", async maxDurationMs => {
  await expect(decodePhotoWithErasure(photo(), { returnPayload: true, maxDurationMs })).rejects.toBeInstanceOf(RangeError);
  expect(scanErasureSeals).not.toHaveBeenCalled(); expect(decodePhoto).not.toHaveBeenCalled();
});
