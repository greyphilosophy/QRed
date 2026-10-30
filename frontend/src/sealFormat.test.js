import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createQRedSeals } from "./qredSealer.js";
import { decodeSeal, verifyQRedSeals } from "./qredVerifier.js";
import { decodeEnvelope, decodeTransport, encodeChunk, encodeEnvelope, encodeMetadata, qrPayloadBytes, sealString, strictUtf8 } from "./sealFormat.js";

const keys = { privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=", publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=" };
const metadata = { timestamp: "2026-10-20T17:55:14.123Z", key_id: "0011223344556677" };

it("uses fixed binary metadata with exact millisecond time and raw key bytes", () => {
  const bytes = encodeMetadata(metadata);
  expect(bytes.length).toBe(17);
  expect(Buffer.from(bytes.subarray(9)).toString("hex")).toBe(metadata.key_id);
  const record = encodeEnvelope(metadata, new Uint8Array(64), new Uint8Array([65]), "plaintext");
  const parsed = decodeEnvelope(record);
  expect(parsed).toMatchObject({ timestamp: metadata.timestamp, key_id: metadata.key_id, pdf: false, page_number: null, page_count: null });
  expect(strictUtf8.decode(parsed.data)).toBe("A");
});

it("encodes 48-bit millisecond timestamps and a 128-bit multipage root", () => {
  const context = { ...metadata, version: "4", pdf: true, page_number: 2, page_count: 3, document_root: "a1".repeat(32) };
  const encoded = encodeMetadata(context);
  expect(encoded).toHaveLength(35);
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const decodedTime = view.getUint32(1) * 65536 + view.getUint16(5);
  expect(decodedTime).toBe(Date.parse(metadata.timestamp));
  expect(Buffer.from(encoded.subarray(19, 35)).toString("hex")).toBe("a1".repeat(16));
  const full = encodeEnvelope({ ...context, identity: { provider: "google", name_source: "google",
    email: "a@b.org", name: "A", subject: "123" } }, new Uint8Array(64),
    new Uint8Array([65]), "plaintext");
  const parsed = decodeEnvelope(full);
  expect(parsed.document_root).toBe("a1".repeat(16));
  expect(parsed.timestamp).toBe(metadata.timestamp);
});

it("uses 40-byte legacy QRC3 framing and compact 24-byte QRC4 framing", () => {
  const body = new Uint8Array([65]);
  const old = encodeChunk(new Uint8Array(32), 0, 2, body, "3");
  const compact = encodeChunk(new Uint8Array(16), 0, 2, body, "4");
  expect(old).toHaveLength(41);
  expect(compact).toHaveLength(25);
  expect(decodeTransport(old)).toMatchObject({ version: "3", chunk_number: 0, total_chunks: 2 });
  expect(decodeTransport(compact)).toMatchObject({ version: "4", chunk_number: 0, total_chunks: 2 });
  expect(decodeTransport(old).digest).toHaveLength(32);
  expect(decodeTransport(compact).digest).toHaveLength(16);
});

it.each([0, 3, 4, 20, 21, 84, 85])("rejects a record truncated to %i bytes", length => {
  const record = encodeEnvelope(metadata, new Uint8Array(64), new Uint8Array([65]), "plaintext");
  expect(() => decodeEnvelope(record.slice(0, length))).toThrow();
});

it.each([4, 9, 11, 12, 15, 16, 128, 255])("rejects unsupported or inconsistent flags %i", flags => {
  const record = encodeEnvelope(metadata, new Uint8Array(64), new Uint8Array([65]), "plaintext");
  record[4] = flags;
  expect(() => decodeEnvelope(record)).toThrow();
});

it("rejects timestamps beyond 48-bit QRS4, without changing legacy QRS3", () => {
  expect(() => encodeMetadata({ ...metadata, version: "4", timestamp: "+012000-01-01T00:00:00.000Z" }))
    .toThrow(/timestamp/);
  const legacy = encodeEnvelope(metadata, new Uint8Array(64), new Uint8Array([65]), "plaintext");
  legacy.fill(255, 5, 13);
  expect(() => decodeEnvelope(legacy)).toThrow(/timestamp/);
});

it.each([[0, 0], [0, 1], [2, 2], [0, 4097]])("rejects malformed chunk index %i / count %i", (index, count) => {
  const bytes = encodeChunk(new Uint8Array(32), 0, 2, new Uint8Array([65]));
  const view = new DataView(bytes.buffer);
  view.setUint16(36, index); view.setUint16(38, count);
  expect(() => decodeTransport(bytes)).toThrow(/index\/count/);
});

it("rejects noncanonical or appended copyable data and invalid UTF-8", async () => {
  const { seals } = await createQRedSeals({ ...keys, content: "Valid", encodingStrategy: "plaintext" });
  for (const seal of [seals[0] + "=", seals[0] + "&ts=bad", "QRED3:%%%", "QRED3:A".repeat(4000)]) expect(decodeSeal(seal)).toBeNull();
  const bytes = qrPayloadBytes(seals[0]); bytes[85] = 255;
  expect(await verifyQRedSeals([sealString(bytes)], keys.publicKey)).toMatchObject({ status: "ERROR" });
});

describe("signed multipage context", () => {
  it.each([22, 24, 25])("rejects alterations to page number, count, or root at byte %i", async offset => {
    const { seals } = await createQRedSeals({ ...keys, content: "Page body", encodingStrategy: "plaintext",
      pageContext: { pageNumber: 1, pageCount: 3, documentRoot: "a1".repeat(32) } });
    const bytes = qrPayloadBytes(seals[0]); bytes[offset] ^= 1;
    expect(await verifyQRedSeals([sealString(bytes)], keys.publicKey)).toMatchObject({ status: "INVALID", metadata_authenticated: false });
  });

  it.each([[0, 2], [3, 2], [1, 0], [1, 65536]])("rejects invalid page position %i / %i", async (pageNumber, pageCount) => {
    await expect(createQRedSeals({ ...keys, content: "Page body", pageContext: { pageNumber, pageCount, documentRoot: "a1".repeat(32) } })).rejects.toThrow(/page position/);
  });

  it("stores a full root once for multipage records, derives single-page hashes, and distinguishes identical pages", async () => {
    const text = "Identical page text";
    const single = await createQRedSeals({ ...keys, content: text, timestamp: metadata.timestamp, encodingStrategy: "plaintext", pageContext: { pageNumber: 1, pageCount: 1 } });
    const recovered = await verifyQRedSeals(single.seals, keys.publicKey);
    expect(recovered).toMatchObject({ status: "VALID", pdf: true, page_number: 1, page_count: 1 });
    expect(recovered.document_root).toBe(recovered.page_hash);
    expect(recovered.page_hash).toHaveLength(64);
    const pages = await Promise.all([1, 2].map(pageNumber => createQRedSeals({ ...keys, content: text, timestamp: metadata.timestamp, encodingStrategy: "plaintext",
      pageContext: { pageNumber, pageCount: 2, documentRoot: "a1".repeat(32) } })));
    expect(pages[0].document_id).not.toBe(pages[1].document_id);
    for (const [index, page] of pages.entries()) {
      expect(qrPayloadBytes(page.seals[0]).length - qrPayloadBytes(single.seals[0]).length).toBe(36);
      expect(await verifyQRedSeals(page.seals, keys.publicKey)).toMatchObject({ status: "VALID", content: text, page_number: index + 1, page_count: 2, document_root: "a1".repeat(32) });
    }
  });
});
