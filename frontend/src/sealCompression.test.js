import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { createQRedSeals } from "./qredSealer.js";
import { createQRedQrData } from "./qredQr.js";
import { decodeSeal, extractHiddenQRedPayload, verifyQRedSeals } from "./qredVerifier.js";
import { gzipText, gunzipChunks, MAX_SEAL_TEXT_BYTES } from "./sealCompression.js";
import { concatenate, decodeEnvelope, encodeBase64Url, encodeEnvelope, qrPayloadBytes, qrPayloadText, sealString } from "./sealFormat.js";

const keys = { privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=", publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=" };
afterEach(() => vi.unstubAllGlobals());

it("replaces a second QR with gzip and stores raw compact bytes", async () => {
  const content = Array.from({ length: 45 }, (_, i) => `Item ${i + 1}: Received and inspected; quantity ${i * 7 + 3}; approved for delivery.`).join("\n");
  const sealed = await createQRedSeals({ ...keys, content });
  expect(sealed.encoding).toBe("gzip");
  expect(sealed.total_seals).toBe(1);
  expect(sealed.candidate_reports.find(c => c.encoding === "plaintext").qr_count).toBe(2);
  const decoded = decodeSeal(sealed.seals[0]);
  expect(gunzipSync(decoded.data).toString("utf8")).toBe(content);
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
  expect(repeated.encoding).toBe("gzip");
});

it.each([[500, 2], [700, 3]])("balances %i gzip records across %i grids and verifies raw reassembly", async (records, count) => {
  const content = Array.from({ length: records }, (_, i) => `${i}: ${Math.imul(i + 17, 2654435761) >>> 0} — 猫 café 🐈`).join("\n");
  const { seals } = await createQRedSeals({ ...keys, content, encodingStrategy: "gzip" });
  expect(seals).toHaveLength(count);
  const qrs = seals.map(seal => createQRedQrData(seal));
  expect(Math.max(...qrs.map(qr => qr.version))).toBeLessThan(40);
  const sizes = seals.map(seal => qrPayloadBytes(seal).length);
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  const record = decodeEnvelope(concatenate(seals.map(seal => decodeSeal(seal).data)));
  expect(gunzipSync(record.data).toString()).toBe(content);
  const scanned = qrs.map(qr => extractHiddenQRedPayload(qr.bytes, qr.version));
  expect(await verifyQRedSeals(scanned.toReversed(), keys.publicKey)).toMatchObject({ status: "VALID", content });
  expect(await verifyQRedSeals(scanned.slice(1), keys.publicKey)).toMatchObject({ status: "INCOMPLETE" });
  expect(await verifyQRedSeals([...scanned, scanned[0]], keys.publicKey)).toMatchObject({ status: "VALID" });
  expect(await verifyQRedSeals(scanned, "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI=")).toMatchObject({ status: "INVALID" });
});

it("rejects altered text even when an attacker supplies a valid replacement gzip stream", async () => {
  const { seals } = await createQRedSeals({ ...keys, content: "Original amount: 123", encodingStrategy: "gzip" });
  const metadata = decodeSeal(seals[0]);
  const altered = sealString(encodeEnvelope(metadata, metadata.signature, await gzipText("Altered amount: 999"), "gzip"));
  expect(await verifyQRedSeals([altered], keys.publicKey)).toMatchObject({ status: "INVALID" });
});

it.each(["plaintext", "gzip"])("preserves a leading Unicode BOM in signed %s text", async encodingStrategy => {
  const content = "\uFEFFCertified Unicode text: 猫 🐈 é";
  const { seals } = await createQRedSeals({ ...keys, content, encodingStrategy });
  expect(await verifyQRedSeals(seals, keys.publicKey)).toMatchObject({ status: "VALID", content });
});

it("rejects corrupt, truncated, non-UTF8, and oversized gzip streams", async () => {
  const valid = gzipSync("Valid Unicode: 猫 🐈 é");
  expect(await gunzipChunks([valid])).toBe("Valid Unicode: 猫 🐈 é");
  const corrupt = new Uint8Array(valid); corrupt[corrupt.length - 8] ^= 1;
  for (const bytes of [corrupt, valid.subarray(0, -1), gzipSync(new Uint8Array([0xff]))]) await expect(gunzipChunks([bytes])).rejects.toThrow();
  await expect(gunzipChunks(["%%%"])).rejects.toThrow(/encoding/);
  await expect(gunzipChunks([encodeBase64Url(gzipSync(new Uint8Array(MAX_SEAL_TEXT_BYTES + 1).fill(65)))])).rejects.toThrow(/8 MiB/);
});

it("keeps custom copyable URLs outside the QR and reconstructs a canonical default URL", async () => {
  const { seals } = await createQRedSeals({ ...keys, content: "Frame checks", encodingStrategy: "gzip", bootstrapUrl: "https://example.org/verify" });
  const bytes = qrPayloadBytes(seals[0]);
  expect(seals[0]).toMatch(/^https:\/\/example.org\/verify#QRED3:/);
  const recovered = qrPayloadText(bytes);
  expect(recovered).toMatch(/^https:\/\/qred.org\/#QRED3:/);
  expect(qrPayloadBytes(recovered)).toEqual(bytes);
  expect(await verifyQRedSeals([recovered], keys.publicKey)).toMatchObject({ status: "VALID" });
  expect(() => qrPayloadText(bytes.slice(0, 5))).toThrow(/truncated/i);
});

it("falls back to plaintext when compression is unavailable and reports an explicit gzip request", async () => {
  vi.stubGlobal("CompressionStream", undefined);
  expect((await createQRedSeals({ ...keys, content: "Offline browser" })).encoding).toBe("plaintext");
  await expect(createQRedSeals({ ...keys, content: "Offline browser", encodingStrategy: "gzip" })).rejects.toThrow(/not available/);
});
