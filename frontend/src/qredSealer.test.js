import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createQRedSeals } from "./qredSealer.js";
import { createQRedQrData } from "./qredQr.js";
import { decodeSeal, verifyQRedSeals } from "./qredVerifier.js";
import { concatenate, decodeEnvelope, qrPayloadBytes, sealString, sha256, encodeChunk, utf8 } from "./sealFormat.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";
const keys = { privateKey, publicKey };
const timestamp = "2026-10-20T17:55:14.123Z";
const changed = (seal, offset) => { const bytes = qrPayloadBytes(seal); bytes[offset] ^= 1; return sealString(bytes); };

describe("compact browser QRed sealing", () => {
  it("stores only compact signed metadata and is independently verifiable with Node Ed25519", async () => {
    const content = "Approved total: 123.45";
    const result = await createQRedSeals({ ...keys, content, timestamp, encodingStrategy: "plaintext" });
    const bytes = qrPayloadBytes(result.seals[0]);
    expect(bytes.length).toBe(85 + utf8.encode(content).length);
    expect(Buffer.from(bytes.subarray(0, 4)).toString()).toBe("QRS3");
    const header = Buffer.alloc(17);
    header.writeBigUInt64BE(BigInt(Date.parse(timestamp)), 1);
    header.set(Buffer.from(result.key_id, "hex"), 9);
    const message = Buffer.concat([Buffer.from("QRed signed document v3\0"), header, Buffer.from(content)]);
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey, "base64url")]), format: "der", type: "spki" });
    expect(nodeVerify(null, message, key, bytes.subarray(21, 85))).toBe(true);
    expect(result).not.toHaveProperty("issuer");
    expect(JSON.parse(result.payload_json)).not.toHaveProperty("issuer");
    expect(Buffer.from(bytes).toString()).not.toMatch(/https:|Ed25519|QRED1|[&?](iss|doc|ts|kid)=/);
    expect(await verifyQRedSeals(result.seals, publicKey)).toMatchObject({ status: "VALID", content, timestamp, key_id: result.key_id });
  });

  it.each([[4, "page context"], [12, "timestamp"], [13, "key ID"], [21, "signature"], [85, "text"]])("rejects altered %s (%s)", async (offset) => {
    const { seals } = await createQRedSeals({ ...keys, content: "Original", encodingStrategy: "plaintext" });
    const altered = offset === 4 ? (() => { const b = qrPayloadBytes(seals[0]); b[4] = 2; return sealString(b); })() : changed(seals[0], offset);
    expect(await verifyQRedSeals([altered], publicKey)).toMatchObject({ status: "INVALID", metadata_authenticated: false });
  });

  it("requires matching keys, nonempty bounded text, and a valid timestamp", async () => {
    const options = { ...keys, content: "Hello" };
    await expect(createQRedSeals({ ...options, publicKey: "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI=" })).rejects.toThrow(/does not match/);
    await expect(createQRedSeals({ ...options, content: " \n " })).rejects.toThrow(/empty document/);
    await expect(createQRedSeals({ ...options, encodingStrategy: "brotli" })).rejects.toThrow(/Unsupported encoding/);
    await expect(createQRedSeals({ ...options, timestamp: "not a date" })).rejects.toThrow(/timestamp/);
    await expect(createQRedSeals({ ...options, content: "a".repeat(8 * 1024 * 1024 + 1) })).rejects.toThrow(/8 MiB/);
  });

  it("distinguishes iterations by their signed timestamps without an extra document ID", async () => {
    const first = await createQRedSeals({ ...keys, content: "Same document text", timestamp });
    const second = await createQRedSeals({ ...keys, content: "Same document text", timestamp: "2026-10-21T17:55:14.123Z" });
    expect(first.document_id).not.toBe(second.document_id);
    for (const sealed of [first, second]) expect(await verifyQRedSeals(sealed.seals, publicKey)).toMatchObject({ status: "VALID", timestamp: sealed.timestamp });
  });

  it("collects raw UTF-8 chunks out of order and rejects missing, conflicting, or mixed chunks", async () => {
    const content = "Hello 🐈 café\n".repeat(300).trim();
    const { seals } = await createQRedSeals({ ...keys, content, encodingStrategy: "plaintext" });
    expect(seals.length).toBeGreaterThan(1);
    expect(await verifyQRedSeals(seals.toReversed(), publicKey)).toMatchObject({ status: "VALID", content });
    expect(await verifyQRedSeals(seals.slice(1), publicKey)).toMatchObject({ status: "INCOMPLETE" });
    expect(await verifyQRedSeals([...seals, seals[0]], publicKey)).toMatchObject({ status: "VALID" });
    expect(await verifyQRedSeals([...seals, changed(seals[0], 45)], publicKey)).toMatchObject({ status: "INVALID" });
    expect(await verifyQRedSeals([changed(seals[0], 4), ...seals.slice(1)], publicKey)).toMatchObject({ status: "INVALID" });
    expect(await verifyQRedSeals([changed(seals[0], 45), ...seals.slice(1)], publicKey)).toMatchObject({ status: "INVALID" });
    const record = concatenate(seals.map(seal => decodeSeal(seal).data));
    record[record.length - 1] ^= 1;
    const forgedDigest = await sha256(record);
    const forged = seals.map((seal, index) => {
      const start = seals.slice(0, index).reduce((sum, item) => sum + decodeSeal(item).data.length, 0);
      return sealString(encodeChunk(forgedDigest, index, seals.length, record.slice(start, start + decodeSeal(seal).data.length)));
    });
    expect(await verifyQRedSeals(forged, publicKey)).toMatchObject({ status: "INVALID", error_message: "Digital signature verification failed" });
  });

  it("balances a 3000-byte record across two smaller grids", async () => {
    const { seals } = await createQRedSeals({ ...keys, content: "x".repeat(3000), encodingStrategy: "plaintext" });
    expect(seals.map(seal => createQRedQrData(seal).version)).toEqual([29, 29]);
    expect(seals.map(seal => qrPayloadBytes(seal).length)).toEqual([1583, 1582]);
    expect(decodeEnvelope(concatenate(seals.map(seal => decodeSeal(seal).data))).signature.length).toBe(64);
  });

  it.each([[2860, [40]], [2861, [28, 28]], [5500, [40, 39]]])("keeps minimum count and beneficial balancing at %i bytes", async (length, versions) => {
    const { seals } = await createQRedSeals({ ...keys, content: "x".repeat(length), encodingStrategy: "plaintext" });
    expect(seals.map(seal => createQRedQrData(seal).version)).toEqual(versions);
  });

  it.each([[27000, 10], [29000, 11]])("balances %i bytes across %i chunks with fixed-size coordinates", async (length, count) => {
    const content = "x".repeat(length);
    const { seals } = await createQRedSeals({ ...keys, content, encodingStrategy: "plaintext" });
    expect(seals).toHaveLength(count);
    expect(Math.max(...seals.map(seal => createQRedQrData(seal).version))).toBeLessThan(40);
    const sizes = seals.map(seal => qrPayloadBytes(seal).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(await verifyQRedSeals(seals.toReversed(), publicKey)).toMatchObject({ status: "VALID", content });
  });

  it("supports four independently scanned chunks for an oversized PDF page", async () => {
    const content = "ABCD".repeat(2300);
    const { seals } = await createQRedSeals({
      ...keys, content, timestamp, encodingStrategy: "plaintext",
      pageContext: { pageNumber: 1, pageCount: 1 },
    });
    expect(seals).toHaveLength(4);
    expect(await verifyQRedSeals(seals.toReversed(), publicKey)).toMatchObject({
      status: "VALID", content, page_number: 1,
    });
    expect(await verifyQRedSeals(seals.slice(1), publicKey)).toMatchObject({ status: "INCOMPLETE" });
  });

  it("uses one full-page QR or four balanced QR chunks, never two or three, for watermark PDFs", async () => {
    const pageContext = { pageNumber: 1, pageCount: 1 };
    const base = { ...keys, timestamp, encodingStrategy: "plaintext", pageContext,
      preferFourQrPage: true };
    const small = await createQRedSeals({ ...base, content: "A".repeat(1500) });
    expect(small.seals).toHaveLength(1);
    const content = "B".repeat(3000);
    const four = await createQRedSeals({ ...base, content });
    const footer = await createQRedSeals({ ...base, preferFourQrPage: false, content });
    expect(four.seals).toHaveLength(4);
    expect(footer.seals).toHaveLength(2);
    expect(new Set(four.seals).size).toBe(4);
    expect(Math.max(...four.seals.map(seal => createQRedQrData(seal).version)))
      .toBeLessThan(Math.max(...footer.seals.map(seal => createQRedQrData(seal).version)));
    expect(await verifyQRedSeals(four.seals.toReversed(), publicKey))
      .toMatchObject({ status: "VALID", content, page_number: 1 });
    expect(await verifyQRedSeals(four.seals.slice(1), publicKey))
      .toMatchObject({ status: "INCOMPLETE" });
  });

  it("stores Unicode and punctuation directly without URL expansion or lost characters", async () => {
    const content = "A *-._~!+'%&= /猫é😀\n".repeat(200).trim();
    const result = await createQRedSeals({ ...keys, content, encodingStrategy: "plaintext", bootstrapUrl: "https://example.org/検証?mode=local" });
    expect(result.payload_bytes).toBe(85 + utf8.encode(content).length + result.total_seals * 40);
    expect(await verifyQRedSeals(result.seals.toReversed(), publicKey)).toMatchObject({ status: "VALID", content });
  });
});
