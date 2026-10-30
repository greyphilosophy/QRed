import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createQRedSeals } from "./qredSealer.js";
import { decodeSeal, verifyQRedSeals } from "./qredVerifier.js";
import { decodeEnvelope, decodeTransport, encodeChunk, encodeEnvelope, encodeMetadata, qrPayloadBytes, sealString, strictUtf8 } from "./sealFormat.js";

const keys = { privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=", publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=" };
const metadata = { timestamp: "2026-10-20T17:55:14.123Z", key_id: "0011223344556677" };

it("uses fixed binary metadata with exact millisecond time and raw key bytes", () => {
  const bytes = encodeMetadata(metadata);
  expect(bytes.length).toBe(15);
  expect(Buffer.from(bytes.subarray(7)).toString("hex")).toBe(metadata.key_id);
  const record = encodeEnvelope(metadata, new Uint8Array(64), new Uint8Array([65]), "plaintext");
  const parsed = decodeEnvelope(record);
  expect(parsed).toMatchObject({ timestamp: metadata.timestamp, key_id: metadata.key_id, pdf: false, page_number: null, page_count: null });
  expect(strictUtf8.decode(parsed.data)).toBe("A");
});

it("encodes 48-bit millisecond timestamps and a 128-bit multipage root", () => {
  const context = { ...metadata, pdf: true, page_number: 2, page_count: 3, document_root: "a1".repeat(32) };
  const encoded = encodeMetadata(context);
  expect(encoded).toHaveLength(35);
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  const decodedTime = view.getUint32(1) * 65536 + view.getUint16(5);
  expect(decodedTime).toBe(Date.parse(metadata.timestamp));
  expect(Buffer.from(encoded.subarray(19, 35)).toString("hex")).toBe("a1".repeat(16));
  const full = encodeEnvelope({ ...context, version: "3" }, new Uint8Array(64),
    new Uint8Array([65]), "plaintext");
  const parsed = decodeEnvelope(full);
  expect(parsed.document_root).toBe("a1".repeat(16));
  expect(parsed.timestamp).toBe(metadata.timestamp);
});

it("uses 128-bit multipart set identifiers but still requires an authentic complete record", async () => {
  const content = "multipart chunk fidelity test: ".repeat(150);
  const sealed = await createQRedSeals({ ...keys, content, encodingStrategy: "plaintext" });
  expect(sealed.seals.length).toBeGreaterThan(1);
  const decoded = sealed.seals.map(seal => decodeTransport(qrPayloadBytes(seal)));
  expect(decoded[0].digest).toHaveLength(16);
  expect(decoded[0].bytes.subarray(0, 4)).toEqual(new Uint8Array([81, 82, 67, 51]));
  expect(decoded[0].bytes.slice(4, 20)).toEqual(decoded[1].bytes.slice(4, 20));
  await expect(verifyQRedSeals(sealed.seals, keys.publicKey)).resolves.toMatchObject({ status: "VALID", content });
  const altered = qrPayloadBytes(sealed.seals[1]);
  altered[24] ^= 1;
  await expect(verifyQRedSeals([sealed.seals[0], sealString(altered)], keys.publicKey))
    .resolves.toMatchObject({ status: "INVALID", error_message: "Seal set digest does not match its contents" });
});

it.each([0, 3, 4, 18, 19, 82, 83])("rejects a record truncated to %i bytes", length => {
  const record = encodeEnvelope(metadata, new Uint8Array(64), new Uint8Array([65]), "plaintext");
  expect(() => decodeEnvelope(record.slice(0, length))).toThrow();
});

it.each([4, 9, 11, 12, 15, 16, 128, 255])("rejects unsupported or inconsistent flags %i", flags => {
  const record = encodeEnvelope(metadata, new Uint8Array(64), new Uint8Array([65]), "plaintext");
  record[4] = flags;
  expect(() => decodeEnvelope(record)).toThrow();
});

it("rejects timestamps outside the 48-bit representable millisecond range", () => {
  expect(() => encodeMetadata({ ...metadata, timestamp: "12000-01-01T00:00:00.000Z" }))
    .toThrow(/timestamp/);
  // The maximum encodable 48-bit time remains a valid JS Date, so there
  // cannot be a bad-timestamp marker in any fully formed 6-byte record.
  const record = encodeEnvelope(metadata, new Uint8Array(64), new Uint8Array([65]), "plaintext");
  record.fill(255, 5, 11);
  expect(() => decodeEnvelope(record)).not.toThrow();
});

it.each([[0, 0], [0, 1], [2, 2], [0, 4097]])("rejects malformed chunk index %i / count %i", (index, count) => {
  const bytes = encodeChunk(new Uint8Array(16), 0, 2, new Uint8Array([65]));
  const view = new DataView(bytes.buffer);
  view.setUint16(20, index); view.setUint16(22, count);
  expect(() => decodeTransport(bytes)).toThrow(/index\/count/);
});

it("rejects noncanonical or appended copyable data and invalid UTF-8", async () => {
  const { seals } = await createQRedSeals({ ...keys, content: "Valid", encodingStrategy: "plaintext" });
  for (const seal of [seals[0] + "=", seals[0] + "&ts=bad", "QRED3:%%%", "QRED3:A".repeat(4000)]) expect(decodeSeal(seal)).toBeNull();
  const bytes = qrPayloadBytes(seals[0]); bytes[83] = 255;
  expect(await verifyQRedSeals([sealString(bytes)], keys.publicKey)).toMatchObject({ status: "ERROR" });
});

describe("signed multipage context", () => {
  it.each([20, 22, 23])("rejects alterations to page number, count, or root at byte %i", async offset => {
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
      expect(qrPayloadBytes(page.seals[0]).length - qrPayloadBytes(single.seals[0]).length).toBe(20);
      expect(await verifyQRedSeals(page.seals, keys.publicKey)).toMatchObject({ status: "VALID", content: text, page_number: index + 1, page_count: 2, document_root: "a1".repeat(16) });
    }
  });
});
