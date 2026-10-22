import { beforeAll, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { Buffer } from "node:buffer";
import { signAsync } from "@noble/ed25519";
import { attestationMessage, pageCommitment } from "./attestation.js";
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
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const signature = await signAsync(attestationMessage(metadata, await pageCommitment(metadata, content, salt)), decodeBase64Url(privateKey));
  return createQRedSeals({ content, pageContext: context, ...extra,
    attestation: { ...metadata, salt, signature: encodeBase64Url(signature), public_key: publicKey } });
}
describe("compact document-specific attestations", () => {
  it("verifies offline using pinned authority keys and never trusts a manually supplied authority", async () => {
    const sealed = await attested("Invoice 42");
    expect(decodeSeal(sealed.seals[0]).version).toBe("4");
    await expect(verifyQRedSeals(sealed.seals, "wrong manual key", trusted)).resolves.toMatchObject({
      status: "VALID", identity_authenticated: true, identity: metadata.identity, page_number: 2, page_count: 3,
    });
    await expect(verifyQRedSeals(sealed.seals, publicKey, {})).resolves.toMatchObject({ status: "UNVERIFIED", identity_authenticated: false });
  });
  it("binds recovered text, page order/count/root, salt, email, name/source, account and server time", async () => {
    const sealed = await attested("Invoice 42", { encodingStrategy: "plaintext" });
    const original = decodeEnvelope(qrPayloadBytes(sealed.seals[0]));
    const modifications = [
      { timestamp: "2025-01-01T00:00:00.000Z" }, { page_number: 1 }, { page_count: 4 },
      { document_root: "cd".repeat(32) }, { salt: new Uint8Array(32) },
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
  it("uses unpredictable fingerprints and rejects substituted server receipts before stamping", async () => {
    const first = crypto.getRandomValues(new Uint8Array(32));
    const second = crypto.getRandomValues(new Uint8Array(32));
    expect(await pageCommitment(metadata, "yes", first)).not.toEqual(await pageCommitment(metadata, "yes", second));
    const signature = await signAsync(attestationMessage(metadata, await pageCommitment(metadata, "First document", first)), decodeBase64Url(privateKey));
    await expect(createQRedSeals({ content: "Changed document", pageContext: context,
      attestation: { ...metadata, salt: first, signature: encodeBase64Url(signature), public_key: publicKey } })).rejects.toThrow("does not match");
  });
  it("recovers a real QR image and reassembles reversed multi-QR attestations", async () => {
    const small = await attested("Synthetic Google attestation QR test.");
    const png = PNG.sync.read(Buffer.from((await qredQrPngDataUrl(small.seals[0], { margin: 4, width: 800 })).split(",")[1], "base64"));
    const pixels = new Uint8ClampedArray(png.data);
    const scanned = scanQrImage(pixels, png.width, png.height);
    const recovered = qredPayloadFromPhotoScanResult(pixels, png.width, png.height, scanned);
    await expect(verifyQRedSeals([recovered], "", trusted)).resolves.toMatchObject({ status: "VALID", content: "Synthetic Google attestation QR test." });
    const content = "Long page with literal payload. ".repeat(220).trimEnd();
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
