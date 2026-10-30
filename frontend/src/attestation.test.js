import { beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { Buffer } from "node:buffer";
import { signAsync } from "@noble/ed25519";
import { attestationMessage, decodeIdentity, encodeIdentity, pageCommitment } from "./attestation.js";
import { decodeBase64Url, decodeEnvelope, encodeBase64Url, encodeEnvelope, qrPayloadBytes, sealString } from "./sealFormat.js";
import { createQRedSeals } from "./qredSealer.js";
import { decodeSeal, verifyQRedSeals } from "./qredVerifier.js";
import { qredQrPngDataUrl } from "./qredQr.js";
import { scanQrImage } from "./qr/scanQrImage.js";
import { qredPayloadFromPhotoScanResult } from "./qredVerifier.js";
import { PNG } from "pngjs";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";
const keyId = "da522162396ab2d0";
const trusted = { [keyId]: publicKey };
const context = { pageNumber: 2, pageCount: 3, documentRoot: "ab".repeat(32) };
const metadata = { version: "4", pdf: true, page_number: 2, page_count: 3, document_root: context.documentRoot,
  key_id: keyId, timestamp: "2026-10-20T00:00:00.000Z", identity: {
    provider: "google", email: "alice@gmail.com", name: "Alice Example", name_source: "google", subject: "1234",
  } };
beforeAll(() => { vi.stubGlobal("crypto", webcrypto); });
async function attested(content, extra = {}) {
  const signature = await signAsync(attestationMessage(metadata, await pageCommitment(metadata, content)), decodeBase64Url(privateKey));
  return createQRedSeals({ content, pageContext: context, ...extra,
    attestation: { ...metadata, signature: encodeBase64Url(signature), public_key: publicKey } });
}
describe("compact document-specific attestations", () => {
  it("preserves the issued Google signing format and reuses the provider byte for new methods", () => {
    // Golden bytes from the pre-provider implementation on main (2baf911).
    const golden = "5152656420476f6f676c6520646f63756d656e74206174746573746174696f6e20763100000001a1569b9800da522162396ab2d00101000f616c69636540676d61696c2e636f6d000d416c696365204578616d706c650004313233342a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a";
    expect(Buffer.from(attestationMessage(metadata, new Uint8Array(32).fill(42))).toString("hex")).toBe(golden);
    const original = encodeIdentity(metadata.identity);
    for (const [index, provider] of ["google", "microsoft", "meta", "amazon"].entries()) {
      const identity = { ...metadata.identity, provider, name_source: provider };
      const bytes = encodeIdentity(identity);
      expect(bytes[0]).toBe(index + 1);
      expect(bytes.subarray(1)).toEqual(original.subarray(1));
      expect(decodeIdentity(bytes).identity).toEqual(identity);
    }
    const unknown = original.slice(); unknown[0] = 5;
    expect(() => decodeIdentity(unknown)).toThrow("Unsupported");
    expect(decodeIdentity(encodeIdentity({ ...metadata.identity, name_source: "self" })).identity.name_source).toBe("self");
  });
  it("verifies offline using pinned authority keys and never trusts a manually supplied authority", async () => {
    const sealed = await attested("Invoice 42");
    expect(decodeSeal(sealed.seals[0]).version).toBe("4");
    await expect(verifyQRedSeals(sealed.seals, "wrong manual key", trusted)).resolves.toMatchObject({
      status: "VALID", identity_authenticated: true, identity: metadata.identity, page_number: 2, page_count: 3,
    });
    await expect(verifyQRedSeals(sealed.seals, publicKey, {})).resolves.toMatchObject({ status: "UNVERIFIED", identity_authenticated: false });
  });
  it("binds recovered text, page order/count/root, email, name/source, account and server time", async () => {
    const sealed = await attested("Invoice 42", { encodingStrategy: "plaintext" });
    const original = decodeEnvelope(qrPayloadBytes(sealed.seals[0]));
    const modifications = [
      { timestamp: "2025-01-01T00:00:00.000Z" }, { page_number: 1 }, { page_count: 4 },
      { document_root: "cd".repeat(32) },
      ...Object.entries({ email: "other@gmail.com", name: "Changed", name_source: "self", subject: "5678" })
        .map(([key, value]) => ({ identity: { ...original.identity, [key]: value } })),
      { data: new TextEncoder().encode("Invoice 43") },
    ];
    for (const change of modifications) {
      const changed = { ...original, ...change };
      const record = encodeEnvelope(changed, original.signature, changed.data, "plaintext");
      await expect(verifyQRedSeals([sealString(record)], "", trusted)).resolves.toMatchObject({ status: "INVALID", identity_authenticated: false });
    }
  });
  it("derives deterministic fingerprints but rejects substituted server receipts before stamping", async () => {
    const first = await pageCommitment(metadata, "yes");
    expect(await pageCommitment(metadata, "yes")).toEqual(first);
    expect(await pageCommitment(metadata, "different")).not.toEqual(first);
    expect(await pageCommitment({ ...metadata, page_number: 1 }, "yes")).not.toEqual(first);
    const signature = await signAsync(attestationMessage(metadata, await pageCommitment(metadata, "First document")), decodeBase64Url(privateKey));
    await expect(createQRedSeals({ content: "Changed document", pageContext: context,
      attestation: { ...metadata, signature: encodeBase64Url(signature), public_key: publicKey } })).rejects.toThrow("does not match");
  });
  it("omits the former 32-byte salt from every QRS4 seal without weakening verification", async () => {
    const content = "Compact account attestation.";
    const sealed = await attested(content, { encodingStrategy: "plaintext" });
    const record = decodeEnvelope(qrPayloadBytes(sealed.seals[0]));
    expect(Object.hasOwn(record, "salt")).toBe(false);
    const wireBytes = qrPayloadBytes(sealed.seals[0]);
    // Four magic bytes, 53 bytes of multipage metadata, encoded identity,
    // 64-byte Ed25519 signature and the uncompressed content. No salt field.
    expect(wireBytes.length).toBe(4 + 53 + encodeIdentity(metadata.identity).length + 64 +
      new TextEncoder().encode(content).length);
    expect(sealed.seals.length).toBe(1);
    await expect(verifyQRedSeals(sealed.seals, "", trusted)).resolves.toMatchObject({
      status: "VALID", identity_authenticated: true, content,
    });
  });
  it("recovers a real QR image and reassembles reversed multi-QR attestations", async () => {
    const small = await attested("Synthetic Google attestation QR test.");
    const png = PNG.sync.read(Buffer.from((await qredQrPngDataUrl(small.seals[0], { margin: 4, width: 800 })).split(",")[1], "base64"));
    const pixels = new Uint8ClampedArray(png.data);
    const scanned = scanQrImage(pixels, png.width, png.height);
    const recovered = qredPayloadFromPhotoScanResult(pixels, png.width, png.height, scanned);
    await expect(verifyQRedSeals([recovered], "", trusted)).resolves.toMatchObject({ status: "VALID", content: "Synthetic Google attestation QR test." });
    const content = "Long page with literal payload. ".repeat(150).trimEnd();
    const large = await attested(content, { encodingStrategy: "plaintext" });
    expect(large.seals.length).toBeGreaterThan(1);
    await expect(verifyQRedSeals(large.seals.toReversed(), "", trusted)).resolves.toMatchObject({ status: "VALID", content });
    await expect(verifyQRedSeals(large.seals.slice(1), "", trusted)).resolves.toMatchObject({ status: "INCOMPLETE" });
  });
  it.each(["zlib", "gzip"])("verifies %s Google attestations offline in single and multiple QRs", async encodingStrategy => {
    const smallContent = "Certified delivery information. ".repeat(20).trimEnd();
    const small = await attested(smallContent, { encodingStrategy });
    expect(small.seals).toHaveLength(1);
    expect(decodeSeal(small.seals[0]).encoding).toBe(encodingStrategy);
    await expect(verifyQRedSeals(small.seals, "", trusted)).resolves.toMatchObject({ status: "VALID", identity_authenticated: true, content: smallContent });
    const content = Array.from({ length: 500 }, (_, i) => `${i}: ${Math.imul(i + 17, 2654435761) >>> 0} — 猫 café 🐈`).join("\n");
    const large = await attested(content, { encodingStrategy });
    expect(large.seals.length).toBeGreaterThan(1);
    await expect(verifyQRedSeals(large.seals.toReversed(), "", trusted)).resolves.toMatchObject({
      status: "VALID", content, encoding: encodingStrategy, identity_authenticated: true,
      identity: metadata.identity, page_number: 2, page_count: 3,
    });
  });
});
