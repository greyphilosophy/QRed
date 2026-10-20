import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { createQRedSeals } from "./qredSealer.js";
import { createQRedQrData } from "./qredQr.js";
import { decodeSeal, extractHiddenQRedPayload, verifyQRedSeals } from "./qredVerifier.js";
import { gzipText, gunzipChunks, qrPayloadBytes, qrPayloadText, MAX_SEAL_TEXT_BYTES } from "./sealCompression.js";
import { decodeBase64Url, encodeBase64Url } from "./sealSignature.js";

const keys = {
  issuer: "QA", privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=",
  publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=",
};
afterEach(() => vi.unstubAllGlobals());

function changed(seal, field, value) {
  const url = new URL(seal);
  const params = new URLSearchParams(url.hash.slice(7));
  params.set(field, value);
  url.hash = `QRED1?${params}`;
  return url.href;
}

it("replaces a second QR with gzip and stores bytes without Base64 expansion", async () => {
  const content = Array.from({ length: 45 }, (_, i) => `Item ${i + 1}: Received and inspected; quantity ${i * 7 + 3}; approved for delivery.`).join("\n");
  const sealed = await createQRedSeals({ ...keys, content });
  expect(sealed.encoding).toBe("gzip");
  expect(sealed.total_seals).toBe(1);
  expect(sealed.candidate_reports.find(c => c.encoding === "plaintext").qr_count).toBe(2);
  const decoded = decodeSeal(sealed.seals[0]);
  // Independent implementation validates both gzip interoperability and text.
  expect(gunzipSync(decodeBase64Url(decoded.data)).toString("utf8")).toBe(content);
  const bytes = qrPayloadBytes(sealed.seals[0]);
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("QRG1");
  const bodyOffset = 6 + ((bytes[4] << 8) | bytes[5]);
  expect(bytes.slice(bodyOffset)).toEqual(decodeBase64Url(decoded.data));
  expect(bytes.length).toBeLessThan(sealed.seals[0].length);
  expect(sealed.compression_savings_pct).toBe(Math.round(100 * (1 - bytes.length / sealed.uncompressed_payload_bytes)));
  expect(JSON.parse(sealed.payload_json).content).toBe(content);
  const qr = createQRedQrData(sealed.seals[0]);
  const recovered = extractHiddenQRedPayload(qr.bytes, qr.version);
  expect(recovered).toBe(sealed.seals[0]);
  expect(await verifyQRedSeals([recovered], keys.publicKey)).toMatchObject({ status: "VALID", content });
});

it("keeps short text uncompressed and uses byte savings to break a one-QR tie", async () => {
  const short = await createQRedSeals({ ...keys, content: "OK" });
  expect(short.encoding).toBe("plaintext");
  const repeated = await createQRedSeals({ ...keys, content: "Approved for delivery. ".repeat(20) });
  expect(repeated.candidate_reports.map(c => c.qr_count)).toEqual([1, 1]);
  expect(repeated.encoding).toBe("gzip");
});

it("keeps a successful plaintext candidate when gzip metadata cannot fit", async () => {
  const sealed = await createQRedSeals({ ...keys, issuer: "I".repeat(2714), content: "OK" });
  expect(sealed.encoding).toBe("plaintext");
  expect(sealed.candidate_reports.find(c => c.encoding === "gzip").error_message).toMatch(/capacity/);
  expect(await verifyQRedSeals(sealed.seals, keys.publicKey)).toMatchObject({ status: "VALID", content: "OK" });
});

it.each([[500, 2], [700, 3]])("balances %i gzip records across %i grids and verifies reassembled chunks", async (records, count) => {
  const content = Array.from({ length: records }, (_, i) => `${i}: ${Math.imul(i + 17, 2654435761) >>> 0} — 猫 café 🐈`).join("\n");
  const { seals } = await createQRedSeals({ ...keys, content, encodingStrategy: "gzip" });
  expect(seals).toHaveLength(count);
  const qrs = seals.map(seal => createQRedQrData(seal));
  expect(Math.max(...qrs.map(qr => qr.version))).toBeLessThan(40);
  const sizes = seals.map(seal => qrPayloadBytes(seal).length);
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(count);
  // Equalize the entire carrier: the signature leaves less space for data in
  // the first code, and Base64 length must not determine a gzip chunk's size.
  expect(decodeBase64Url(decodeSeal(seals[0]).data).length).toBeLessThan(decodeBase64Url(decodeSeal(seals[1]).data).length);
  const scanned = qrs.map(qr => extractHiddenQRedPayload(qr.bytes, qr.version));
  expect(await verifyQRedSeals(scanned.toReversed(), keys.publicKey)).toMatchObject({ status: "VALID", content });
  expect(await verifyQRedSeals(scanned.slice(1), keys.publicKey)).toMatchObject({ status: "INCOMPLETE" });
  expect(await verifyQRedSeals([...scanned, scanned[0]], keys.publicKey)).toMatchObject({ status: "VALID" });
  expect(await verifyQRedSeals([...scanned, changed(scanned[0], "txt", "AAAA")], keys.publicKey)).toMatchObject({ status: "INVALID" });
  expect(await verifyQRedSeals([scanned[0], changed(scanned[1], "rc", "plaintext"), ...scanned.slice(2)], keys.publicKey)).toMatchObject({ status: "INVALID" });
  expect(await verifyQRedSeals(scanned, "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI=")).toMatchObject({ status: "INVALID" });
});

it("rejects altered signed text even when it is a valid new gzip stream", async () => {
  const { seals } = await createQRedSeals({ ...keys, content: "Original amount: 123", encodingStrategy: "gzip" });
  const altered = changed(seals[0], "txt", encodeBase64Url(await gzipText("Altered amount: 999")));
  expect(await verifyQRedSeals([altered], keys.publicKey)).toMatchObject({ status: "INVALID" });
  expect(await verifyQRedSeals([changed(seals[0], "iss", "False issuer")], keys.publicKey)).toMatchObject({ status: "INVALID" });
  expect(await verifyQRedSeals([changed(seals[0], "rc", "retired-encoding")], keys.publicKey)).toMatchObject({ status: "ERROR" });
});

it("preserves a leading Unicode BOM in the signed text", async () => {
  const content = "\uFEFFCertified Unicode text: 猫 🐈 é";
  const { seals } = await createQRedSeals({ ...keys, content, encodingStrategy: "gzip" });
  expect(await verifyQRedSeals(seals, keys.publicKey)).toMatchObject({ status: "VALID", content });
});

it("rejects corrupt, truncated, non-UTF8, and oversized gzip streams", async () => {
  const valid = gzipSync("Valid Unicode: 猫 🐈 é");
  expect(await gunzipChunks([encodeBase64Url(valid)])).toBe("Valid Unicode: 猫 🐈 é");
  const corrupt = new Uint8Array(valid); corrupt[corrupt.length - 8] ^= 1;
  for (const bytes of [corrupt, valid.subarray(0, -1), gzipSync(new Uint8Array([0xff]))]) {
    await expect(gunzipChunks([encodeBase64Url(bytes)])).rejects.toThrow();
  }
  await expect(gunzipChunks(["%%%"])).rejects.toThrow(/encoding/);
  const oversized = gzipSync(new Uint8Array(MAX_SEAL_TEXT_BYTES + 1).fill(65));
  await expect(gunzipChunks([encodeBase64Url(oversized)])).rejects.toThrow(/8 MiB/);
});

it("rejects truncated binary framing and preserves a custom bootstrap URL", async () => {
  const { seals } = await createQRedSeals({ ...keys, content: "Frame checks", encodingStrategy: "gzip", bootstrapUrl: "https://example.org/verify" });
  const bytes = qrPayloadBytes(seals[0]);
  expect(qrPayloadText(bytes)).toBe(seals[0]);
  expect(() => qrPayloadText(bytes.slice(0, 5))).toThrow(/Truncated/);
  const bad = new Uint8Array(bytes); bad[4] = 255; bad[5] = 255;
  expect(() => qrPayloadText(bad)).toThrow(/Truncated/);
});

it("falls back to plaintext when compression is unavailable and reports an explicit gzip request", async () => {
  vi.stubGlobal("CompressionStream", undefined);
  expect((await createQRedSeals({ ...keys, content: "Offline browser" })).encoding).toBe("plaintext");
  await expect(createQRedSeals({ ...keys, content: "Offline browser", encodingStrategy: "gzip" })).rejects.toThrow(/not available/);
});
