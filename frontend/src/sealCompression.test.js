import { deflateSync, gunzipSync, gzipSync, inflateSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { createQRedSeals } from "./qredSealer.js";
import { createQRedQrData } from "./qredQr.js";
import { decodeSeal, extractHiddenQRedPayload, verifyQRedSeals } from "./qredVerifier.js";
import { compressText, decompressChunks, MAX_SEAL_TEXT_BYTES } from "./sealCompression.js";
import { concatenate, decodeEnvelope, encodeBase64Url, encodeEnvelope, qrPayloadBytes, qrPayloadText, sealString } from "./sealFormat.js";

const keys = { privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=", publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=" };
afterEach(() => vi.unstubAllGlobals());

it("replaces a second QR with zlib and stores raw compact bytes", async () => {
  const content = Array.from({ length: 45 }, (_, i) => `Item ${i + 1}: Received and inspected; quantity ${i * 7 + 3}; approved for delivery.`).join("\n");
  const sealed = await createQRedSeals({ ...keys, content });
  expect(sealed.encoding).toBe("zlib");
  expect(sealed.total_seals).toBe(1);
  expect(sealed.candidate_reports.find(c => c.encoding === "plaintext").qr_count).toBe(2);
  const decoded = decodeSeal(sealed.seals[0]);
  expect(inflateSync(decoded.data).toString("utf8")).toBe(content);
  const bytes = qrPayloadBytes(sealed.seals[0]);
  expect(bytes.slice(85)).toEqual(decoded.data);
  expect(bytes.length).toBeLessThan(sealed.seals[0].length);
  expect(sealed.compression_savings_pct).toBe(Math.round(100 * (1 - bytes.length / sealed.uncompressed_payload_bytes)));
  const qr = createQRedQrData(sealed.seals[0]);
  const recovered = extractHiddenQRedPayload(qr.bytes, qr.version);
  expect(recovered).toBe(sealed.seals[0]);
  expect(await verifyQRedSeals([recovered], keys.publicKey)).toMatchObject({ status: "VALID", content });
});

it("keeps short text uncompressed and uses byte savings to break a one-QR tie", async () => {
  expect((await createQRedSeals({ ...keys, content: "OK" })).encoding).toBe("plaintext");
  const repeated = await createQRedSeals({ ...keys, content: "Approved for delivery. ".repeat(20) });
  expect(repeated.candidate_reports.map(c => c.qr_count)).toEqual([1, 1]);
  expect(repeated.encoding).toBe("zlib");
});

it("saves 12 wrapper bytes without changing signatures and keeps gzip seals readable", async () => {
  const content = "Approved for delivery. ".repeat(20).trimEnd();
  const options = { ...keys, content, timestamp: "2026-10-20T00:00:00.000Z" };
  const gzip = await createQRedSeals({ ...options, encodingStrategy: "gzip" });
  const zlib = await createQRedSeals(options);
  const oldRecord = decodeSeal(gzip.seals[0]), newRecord = decodeSeal(zlib.seals[0]);
  expect(zlib.encoding).toBe("zlib");
  expect(gzip.payload_bytes - zlib.payload_bytes).toBe(12);
  expect(oldRecord.data.slice(10, -8)).toEqual(newRecord.data.slice(2, -4));
  expect(oldRecord.signature).toEqual(newRecord.signature);
  expect(gunzipSync(oldRecord.data).toString()).toBe(content);
  expect(inflateSync(newRecord.data).toString()).toBe(content);
  for (const sealed of [gzip, zlib]) expect(await verifyQRedSeals(sealed.seals, keys.publicKey)).toMatchObject({ status: "VALID", content });
});

it.each(["zlib", "gzip"].flatMap(encoding => [[500, 2, encoding], [700, 3, encoding]]))("balances %i records across %i %s grids and verifies raw reassembly", async (records, count, encoding) => {
  const content = Array.from({ length: records }, (_, i) => `${i}: ${Math.imul(i + 17, 2654435761) >>> 0} — 猫 café 🐈`).join("\n");
  const { seals } = await createQRedSeals({ ...keys, content, encodingStrategy: encoding });
  expect(seals).toHaveLength(count);
  const qrs = seals.map(seal => createQRedQrData(seal));
  expect(Math.max(...qrs.map(qr => qr.version))).toBeLessThan(40);
  const sizes = seals.map(seal => qrPayloadBytes(seal).length);
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  const record = decodeEnvelope(concatenate(seals.map(seal => decodeSeal(seal).data)));
  expect((encoding === "zlib" ? inflateSync : gunzipSync)(record.data).toString()).toBe(content);
  const scanned = qrs.map(qr => extractHiddenQRedPayload(qr.bytes, qr.version));
  expect(await verifyQRedSeals(scanned.toReversed(), keys.publicKey)).toMatchObject({ status: "VALID", content });
  expect(await verifyQRedSeals(scanned.slice(1), keys.publicKey)).toMatchObject({ status: "INCOMPLETE" });
  expect(await verifyQRedSeals([...scanned, scanned[0]], keys.publicKey)).toMatchObject({ status: "VALID" });
  expect(await verifyQRedSeals(scanned, "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI=")).toMatchObject({ status: "INVALID" });
});

it.each(["zlib", "gzip"])("rejects altered text even when an attacker supplies a valid replacement %s stream", async encoding => {
  const { seals } = await createQRedSeals({ ...keys, content: "Original amount: 123", encodingStrategy: encoding });
  const metadata = decodeSeal(seals[0]);
  const altered = sealString(encodeEnvelope(metadata, metadata.signature, await compressText("Altered amount: 999", encoding), encoding));
  expect(await verifyQRedSeals([altered], keys.publicKey)).toMatchObject({ status: "INVALID" });
});

it.each(["plaintext", "zlib", "gzip"])("preserves a leading Unicode BOM in signed %s text", async encodingStrategy => {
  const content = "\uFEFFCertified Unicode text: 猫 🐈 é";
  const { seals } = await createQRedSeals({ ...keys, content, encodingStrategy });
  expect(await verifyQRedSeals(seals, keys.publicKey)).toMatchObject({ status: "VALID", content });
});

it.each(["zlib", "gzip"])("rejects corrupt, truncated, appended, non-UTF8, and oversized %s streams", async encoding => {
  const compress = encoding === "zlib" ? deflateSync : gzipSync;
  const valid = compress("Valid Unicode: 猫 🐈 é");
  expect(await decompressChunks([valid.subarray(0, 5), valid.subarray(5)], encoding)).toBe("Valid Unicode: 猫 🐈 é");
  const corrupt = new Uint8Array(valid); corrupt[corrupt.length - (encoding === "zlib" ? 4 : 8)] ^= 1;
  for (const bytes of [corrupt, valid.subarray(0, -1), concatenate([valid, new Uint8Array([1])]), compress(new Uint8Array([0xff]))]) {
    await expect(decompressChunks([bytes], encoding)).rejects.toThrow();
  }
  await expect(decompressChunks(["%%%"], encoding)).rejects.toThrow(/encoding/);
  await expect(decompressChunks([encodeBase64Url(compress(new Uint8Array(MAX_SEAL_TEXT_BYTES + 1).fill(65)))], encoding)).rejects.toThrow(/8 MiB/);
});

it("keeps custom copyable URLs outside the QR and reconstructs a canonical default URL", async () => {
  const { seals } = await createQRedSeals({ ...keys, content: "Frame checks", encodingStrategy: "zlib", bootstrapUrl: "https://example.org/verify" });
  const bytes = qrPayloadBytes(seals[0]);
  expect(seals[0]).toMatch(/^https:\/\/example.org\/verify#QRED3:/);
  const recovered = qrPayloadText(bytes);
  expect(recovered).toMatch(/^https:\/\/qred.org\/#QRED3:/);
  expect(qrPayloadBytes(recovered)).toEqual(bytes);
  expect(await verifyQRedSeals([recovered], keys.publicKey)).toMatchObject({ status: "VALID" });
  expect(() => qrPayloadText(bytes.slice(0, 5))).toThrow(/truncated/i);
});

it("falls back to plaintext when compression is unavailable and reports explicit compression requests", async () => {
  vi.stubGlobal("CompressionStream", undefined);
  expect((await createQRedSeals({ ...keys, content: "Offline browser" })).encoding).toBe("plaintext");
  for (const encodingStrategy of ["zlib", "gzip"]) {
    await expect(createQRedSeals({ ...keys, content: "Offline browser", encodingStrategy })).rejects.toThrow(/not available/);
  }
});

it("can still compress and verify when a browser supports only gzip", async () => {
  const NativeCompressionStream = CompressionStream;
  vi.stubGlobal("CompressionStream", vi.fn(function (format) {
    if (format === "deflate") throw new TypeError("Unsupported compression format");
    return new NativeCompressionStream(format);
  }));
  const content = "Approved for delivery. ".repeat(20).trimEnd();
  const sealed = await createQRedSeals({ ...keys, content });
  expect(sealed.encoding).toBe("gzip");
  expect(await verifyQRedSeals(sealed.seals, keys.publicKey)).toMatchObject({ status: "VALID", content });
  await expect(createQRedSeals({ ...keys, content, encodingStrategy: "zlib" })).rejects.toThrow(/Unsupported compression format/);
});
