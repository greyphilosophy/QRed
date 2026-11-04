import { beforeAll, expect, it } from "vitest";
import { encodeErasureChunks, decodeErasureChunk, recoverErasureRecord } from "./erasureTransport.js";
import { createQRedSeals } from "./qredSealer.js";
import { qrPayloadBytes, qrPayloadText, sealString, decodeTransport, encodeEnvelope } from "./sealFormat.js";
import { decodeSeal, verifyQRedSeals } from "./qredVerifier.js";
import { verifySealCollection, sealCollectionProgress } from "./sealCollection.js";
import { qredPayloadFromScanResult } from "./qr/qrPayload.js";
const keys = { privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=", publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=" };
let record, shards;
beforeAll(async () => {
  const sealed = await createQRedSeals({ ...keys, content: "Invoice 1042\nAmount 50.00", timestamp: "2026-11-04T07:00:00Z" });
  record = qrPayloadBytes(sealed.seals[0]); shards = await encodeErasureChunks(record);
});
const strings = chunks => chunks.map(chunk => sealString(chunk));
function* choose(values, count, prefix = []) {
  if (!count) { yield prefix; return; }
  for (let i = 0; i <= values.length - count; i++) yield* choose(values.slice(i + 1), count - 1, [...prefix, values[i]]);
}
it("recovers the exact signed envelope after every combination of four missing shards", async () => {
  let count = 0;
  for (const subset of choose(shards, 12)) { expect(await recoverErasureRecord(subset)).toEqual(record); count++; }
  expect(count).toBe(1820);
}, 30000);
it("round-trips byte QR and copy/paste framing then authenticates normally", async () => {
  const urls = strings(shards.slice(4));
  expect(qrPayloadText(shards[0])).toBe(sealString(shards[0]));
  expect(qredPayloadFromScanResult({ binaryData: shards[0] })).toBe(sealString(shards[0]));
  expect(decodeTransport(shards[0])).toMatchObject({ version: "3", erasure: true, transport_version: 1, required_chunks: 12, total_chunks: 16 });
  expect(await verifyQRedSeals(urls, keys.publicKey)).toMatchObject({ status: "VALID", content: "Invoice 1042\nAmount 50.00", signature_valid: true });
  expect(await verifyQRedSeals([...urls, urls[0]], keys.publicKey)).toMatchObject({ status: "VALID" });
  expect(await verifyQRedSeals(urls.slice(1), keys.publicKey)).toMatchObject({ status: "INCOMPLETE", required_chunks: 12, collected_chunks: 11 });
  expect(await verifyQRedSeals(urls, "")).toMatchObject({ status: "UNVERIFIED", signature_valid: false });
  expect(await verifyQRedSeals(urls, keys.privateKey)).toMatchObject({ status: "INVALID" });
});
it("counts recovery threshold without claiming every printed shard was collected", async () => {
  const urls = strings(shards.slice(4)), results = await verifySealCollection(urls, keys.publicKey);
  expect(sealCollectionProgress(urls, results)).toMatchObject({ complete: true, finished: true, total: 12, message: "Enough QR seals recovered." });
  expect(sealCollectionProgress(urls.slice(1), [])).toMatchObject({ complete: false, total: 12 });
});
it.each([[2, 3], [2, 4], [3, 5], [15, 16]])("recovers allowed small subsets k=%i n=%i", async (required, total) => {
  const encoded = await encodeErasureChunks(record, { required, total });
  for (const subset of choose(encoded, required)) expect(await recoverErasureRecord(subset)).toEqual(record);
});
it("rejects corrupt selected shards, unused parity, and conflicting duplicates", async () => {
  const changed = shards[15].slice(); changed[changed.length - 1] ^= 1;
  expect((await verifyQRedSeals(strings([...shards.slice(0, 15), changed]), keys.publicKey)).status).not.toBe("VALID");
  expect((await verifyQRedSeals(strings([...shards.slice(4, 15), changed]), keys.publicKey)).status).not.toBe("VALID");
  expect(await verifyQRedSeals(strings([...shards, changed]), keys.publicKey)).toMatchObject({ status: "INVALID", error_message: "Conflicting duplicate chunk" });
  await expect(recoverErasureRecord([...shards.slice(0, 12), shards[0]])).rejects.toThrow("duplicate");
});
it("does not mix envelopes or transport parameter sets", async () => {
  const other = record.slice(); other[other.length - 1] ^= 1;
  const a = await encodeErasureChunks(other), b = await encodeErasureChunks(record, { required: 11, total: 16 });
  for (const foreign of [a[15], b[15], record]) expect(await verifyQRedSeals(strings([...shards.slice(0, 12), foreign]), keys.publicKey)).toMatchObject({ status: "INVALID" });
  const grouped = await verifySealCollection(strings([...shards.slice(0, 12), b[15]]), keys.publicKey);
  expect(grouped.map(result => result.status)).toEqual(["VALID", "INCOMPLETE"]);
});
it("does not confuse a valid digest with an authentic signature", async () => {
  const modified = record.slice(); modified[30] ^= 1;
  expect(await verifyQRedSeals(strings(await encodeErasureChunks(modified)), keys.publicKey)).toMatchObject({ status: "INVALID", signature_valid: false });
});
it.each([[4, 2], [5, 2], [6, 0], [6, 17], [7, 12], [7, 17], [8, 16], [9, 1], [10, 255], [14, 255]])("rejects malformed header byte %i=%i before reconstruction", (offset, value) => {
  const changed = shards[0].slice(); changed[offset] = value;
  expect(() => decodeErasureChunk(changed)).toThrow(); expect(decodeSeal(sealString(changed))).toBeNull();
});
it("rejects truncated/overlong bodies and bounds matrix and allocation work", async () => {
  expect(() => decodeErasureChunk(shards[0].slice(0, -1))).toThrow();
  const longer = new Uint8Array(shards[0].length + 1); longer.set(shards[0]);
  expect(() => decodeErasureChunk(longer)).toThrow();
  await expect(recoverErasureRecord(Array(17).fill(shards[0]))).rejects.toThrow("collection size");
  await expect(encodeErasureChunks(record, { required: 16, total: 17 })).rejects.toThrow();
  await expect(encodeErasureChunks(new Uint8Array(50000))).rejects.toThrow();
  expect(await verifyQRedSeals(Array(4097).fill(sealString(shards[0])), keys.publicKey)).toMatchObject({ status: "ERROR" });
});
it("retains QRS4 framing and refuses to authenticate a fake attestation", async () => {
  const bytes = encodeEnvelope({ version: "4", timestamp: "2026-11-04T07:00:00Z", key_id: "0011223344556677",
    identity: { provider: "google", name_source: "google", email: "a@b.org", name: "A", subject: "123" } },
    new Uint8Array(64), new TextEncoder().encode("Example"), "plaintext");
  const urls = strings(await encodeErasureChunks(bytes));
  expect(urls.every(url => url.includes("#QRED4:"))).toBe(true);
  expect(await recoverErasureRecord(urls.slice(4).map(qrPayloadBytes))).toEqual(bytes);
  expect(await verifyQRedSeals(urls, keys.publicKey, { "0011223344556677": keys.publicKey })).toMatchObject({ status: "INVALID", identity_authenticated: false });
});
it("freezes a transport vector and handles nonzero-offset byte views", async () => {
  const fixture = Uint8Array.from({ length: 86 }, (_, i) => i); fixture.set([81, 82, 83, 51]);
  const encoded = await encodeErasureChunks(fixture, { required: 2, total: 3 });
  expect(Array.from(encoded[0], b => b.toString(16).padStart(2, "0")).join("")).toBe(
    "5152453301010203000000000056002bc15047a5f05769d75662cd1edb450eba9100da120463a61068ab68b649d2f5ca7a7e7e1d2b3537353b3d3f3d3b3537352b2d2f2d2b5557555b5d5f5d5b5557556b6d6f6d6b7577757b7d7f");
  const views = encoded.slice(1).reverse().map(bytes => { const buffer = new Uint8Array(bytes.length + 11); buffer.set(bytes, 7); return buffer.subarray(7, 7 + bytes.length); });
  expect(await recoverErasureRecord(views)).toEqual(fixture);
});
it("rejects padding-only changes even when the recovered trimmed-envelope digest matches", async () => {
  const fixture = new Uint8Array(87); fixture.set([81, 82, 83, 51]);
  const encoded = await encodeErasureChunks(fixture, { required: 2, total: 3 });
  // Source block 1's final padding byte is changed from zero to one.
  // Its coded contribution is x=index+1 for this k=2 Vandermonde matrix.
  encoded.forEach((bytes, index) => { bytes[bytes.length - 1] ^= index + 1; });
  await expect(recoverErasureRecord(encoded.slice(0, 2))).rejects.toThrow("padding");
});
it("enables many-shard creation only through the explicit experimental option", async () => {
  const options = { ...keys, content: "Invoice 1042", pageContext: { pageNumber: 1, pageCount: 1 } };
  expect((await createQRedSeals(options)).seals).toHaveLength(1);
  const explicit = await createQRedSeals({ ...options, experimentalErasure: { required: 12, total: 16 } });
  expect(explicit.seals).toHaveLength(16);
  expect(await verifyQRedSeals(explicit.seals.slice(4), keys.publicKey)).toMatchObject({ status: "VALID", pdf: true });
});
