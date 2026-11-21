import { expect, it } from "vitest";
import { signAsync } from "@noble/ed25519";
import { createDocumentBundle, decodeDocumentBundle } from "./documentBundle.js";
import { createQRedSeals } from "./qredSealer.js";
import { decodeSeal, verifyQRedSeals } from "./qredVerifier.js";
import { sealCollectionProgress, verifySealCollection } from "./sealCollection.js";
import { concatenate, decodeBase64Url, encodeBase64Url, qrPayloadBytes, qrPayloadText, sealString } from "./sealFormat.js";
import { attestationMessage, pageCommitment } from "./attestation.js";
import { decodePhoto } from "./qr/decodePhoto.js";
import { createQRedQrSymbol } from "./qredQr.js";
import { sealSheetString } from "./sealFormat.js";
import { computeKeyId } from "./sealSignature.js";
const keys = { privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q" };
const timestamp = "2026-01-01T00:00:00.000Z", root = "ab".repeat(32);
function noise(size) {
  let seed = 1234567;
  return Array.from({ length: size }, () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return String.fromCharCode(33 + ((seed >>> 0) % 90));
  }).join("");
}
const makePages = (count = 6, text = noise(5000)) => Promise.all(Array.from({ length: count }, (_, i) =>
  createQRedSeals({ ...keys, content: `Fictional page ${i + 1}. ${text}`, timestamp,
    pageContext: { pageNumber: i + 1, pageCount: count, documentRoot: root } })));

it("compresses across pages, retains signatures, and collects pieces in any order", async () => {
  const records = await makePages(), bundle = await createDocumentBundle(records);
  const oldBytes = records.flatMap(page => page.seals).reduce((n, seal) => n + qrPayloadBytes(seal).length, 0);
  expect(bundle.payload_bytes).toBeLessThan(oldBytes / 2);
  expect(bundle.seals.length).toBeGreaterThan(1);
  expect(bundle.seals.length).toBeLessThan(records.flatMap(page => page.seals).length);
  for (const seal of bundle.seals) {
    expect(qrPayloadText(qrPayloadBytes(seal))).toBe(seal);
    expect(qrPayloadBytes(seal).length).toBeLessThanOrEqual(2953);
    expect(decodeSeal(seal)).toMatchObject({ version: "5", document_bundle: true, seal_sheet: true });
  }
  const partial = [bundle.seals.at(-1), bundle.seals.at(-1)];
  const waiting = await verifySealCollection(partial, keys.publicKey);
  expect(waiting).toHaveLength(1); expect(waiting[0].status).toBe("INCOMPLETE");
  expect(sealCollectionProgress(partial, waiting)).toMatchObject({ collected: 1, complete: false, finished: false });
  expect(sealCollectionProgress(partial, waiting).message).toContain("document seals");
  const scanned = [...bundle.seals].reverse(), results = await verifySealCollection(scanned, keys.publicKey);
  expect(results.map(page => [page.status, page.page_number])).toEqual(records.map((_, i) => ["VALID", i + 1]));
  for (const [index, page] of results.entries()) {
    const original = await verifyQRedSeals(records[index].seals, keys.publicKey);
    expect(page).toMatchObject({ content: original.content, page_hash: original.page_hash, record_id: original.record_id,
      signature_valid: true, metadata_authenticated: true, seal_sheet: true });
  }
  expect(sealCollectionProgress(scanned, results)).toMatchObject({ complete: true, finished: true, pagesCollected: 6 });
  expect(sealCollectionProgress(scanned, results).message).toContain("photograph the 6 original pages");
});
it("deduplicates a signed page recovered from both its watermark and the bundle", async () => {
  const records = await makePages(2), bundle = await createDocumentBundle(records);
  for (const seals of [[...records[0].seals, ...bundle.seals], [...bundle.seals, ...records[0].seals]]) {
    const results = await verifySealCollection(seals, keys.publicKey);
    expect(results).toHaveLength(2);
    expect(results[0].document_id).toBe(decodeSeal(records[0].seals[0]).document_id);
    expect(results[0].photo_ids).toContain(results[0].record_id);
    expect(results.every(page => page.status === "VALID")).toBe(true);
  }
});
it("supports one document code and still requires the correct trusted key", async () => {
  const bundle = await createDocumentBundle(await makePages(1, "Short original page."));
  expect(bundle.seals).toHaveLength(1);
  expect(await verifyQRedSeals(bundle.seals, keys.publicKey)).toMatchObject({ status: "VALID", document_bundle: true,
    pages: [{ page_number: 1, page_count: 1, seal_sheet: true }] });
  expect(await verifyQRedSeals(bundle.seals)).toMatchObject({ status: "UNVERIFIED", pages: [{ signature_valid: false }] });
  expect(await verifyQRedSeals(bundle.seals, "invalid key")).toMatchObject({ status: "INVALID", pages: [{ status: "INVALID" }] });
});
it("rejects altered, conflicting and mixed document pieces", async () => {
  const bundle = await createDocumentBundle(await makePages());
  const changed = qrPayloadBytes(bundle.seals[0]); changed[changed.length - 1] ^= 1;
  expect((await verifyQRedSeals([sealString(changed), ...bundle.seals.slice(1)], keys.publicKey)).status).toBe("INVALID");
  expect((await verifyQRedSeals([...bundle.seals, sealString(changed)], keys.publicKey)).status).toBe("INVALID");
  const other = await createDocumentBundle(await makePages(2, noise(6000)));
  expect((await verifyQRedSeals([...bundle.seals, other.seals[0]], keys.publicKey)).status).toBe("INVALID");
  changed.set([0, 0], 38); expect(decodeSeal(sealString(changed))).toBeNull();
});
it("rejects a forged page even when its outer digest is correctly rebuilt", async () => {
  const records = await makePages(1, "Payment 100");
  const bytes = qrPayloadBytes(records[0].seals[0]); bytes[21] ^= 1;
  const bundle = await createDocumentBundle([{ seals: [sealString(bytes)] }]);
  const results = await verifySealCollection(bundle.seals, keys.publicKey);
  expect(results[0]).toMatchObject({ status: "INVALID", signature_valid: false });
  expect(sealCollectionProgress(bundle.seals, results)).toMatchObject({ complete: false, finished: true });
});
it("rejects missing pages, repeated positions and mixed signing versions", async () => {
  const records = await makePages(2, "Short original");
  await expect(createDocumentBundle([records[0]])).rejects.toThrow("every page");
  await expect(createDocumentBundle([records[0], records[0]])).rejects.toThrow("exactly once");
  const other = await createQRedSeals({ ...keys, timestamp: "2026-01-02T00:00:00.000Z", content: "Short original",
    pageContext: { pageNumber: 2, pageCount: 2, documentRoot: root } });
  await expect(createDocumentBundle([records[0], other])).rejects.toThrow("one signing version");
});
it("validates bundle framing and forbids nested compressed records", async () => {
  for (const bytes of [new Uint8Array([9, 0, 1, 0]), new Uint8Array([0, 0, 0, 0]),
    new Uint8Array([0, 0, 1, 255, 255, 255, 255]), new Uint8Array([1, 1, 2, 3])]) {
    await expect(decodeDocumentBundle(bytes)).rejects.toThrow();
  }
  const record = await createQRedSeals({ ...keys, content: "Repeated words ".repeat(100), encodingStrategy: "zlib",
    pageContext: { pageNumber: 1, pageCount: 1 } });
  const raw = qrPayloadBytes(record.seals[0]), prefix = new Uint8Array(7);
  prefix.set([0, 0, 1]); new DataView(prefix.buffer).setUint32(3, raw.length);
  await expect(decodeDocumentBundle(concatenate([prefix, raw]))).rejects.toThrow("Nested compression");
});
it("preserves trusted account attestations inside a jointly compressed document", async () => {
  const keyId = await computeKeyId(keys.publicKey), records = [];
  for (let number = 1; number <= 2; number++) {
    const content = `Fictional account-signed page ${number}`;
    const metadata = { version: "4", key_id: keyId, timestamp, pdf: true, page_number: number, page_count: 2,
      document_root: root.slice(0, 32), identity: { provider: "google", email: "example@example.test", name: "Test Signer", subject: "test-subject", name_source: "google" } };
    const signature = await signAsync(attestationMessage(metadata, await pageCommitment(metadata, content)), decodeBase64Url(keys.privateKey));
    records.push(await createQRedSeals({ content, pageContext: { pageNumber: number, pageCount: 2, documentRoot: root.slice(0, 32) }, attestation: { ...metadata, public_key: keys.publicKey, signature: encodeBase64Url(signature) } }));
  }
  const bundle = await createDocumentBundle(records);
  const result = await verifyQRedSeals(bundle.seals, undefined, { [keyId]: keys.publicKey });
  expect(result.status).toBe("VALID");
  expect(result.pages.every(page => page.version === "4" && page.identity_authenticated)).toBe(true);
});

it("reads individual old and bundled seals from a close-up with no page corners", async () => {
  const records = await makePages(1, "Individual seal ".repeat(70));
  const bundle = await createDocumentBundle(records);
  for (const seal of [sealSheetString(records[0].seals[0]), bundle.seals[0]]) {
    const symbol = createQRedQrSymbol(seal), width = (symbol.modules.size + 8) * 5;
    const data = new Uint8ClampedArray(width * width * 4).fill(255);
    for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
      const row = Math.floor(y / 5) - 4, col = Math.floor(x / 5) - 4;
      if (row >= 0 && col >= 0 && row < symbol.modules.size && col < symbol.modules.size && symbol.modules.get(row, col)) {
        const at = (y * width + x) * 4; data[at] = data[at + 1] = data[at + 2] = 0;
      }
    }
    const stages = [];
    expect(decodePhoto({ data, width, height: width }, { returnPayload: true, sealOnly: true, onStage: stage => stages.push(stage.stage) }))
      .toEqual({ status: "found", text: seal });
    expect(stages).toEqual(["ordinary-qr"]);
  }
});
