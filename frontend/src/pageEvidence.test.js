import { runInNewContext } from "node:vm";
import { sealSignatureMessage } from "./sealSignature.js";
import { describe, expect, it } from "vitest";
import { signAsync } from "@noble/ed25519";
import { CODEBOOK, decodePageEvidence, encodePageEvidence, encodeVisualReference, renderVisualReference } from "./pageEvidence.js";
import { createQRedSeals, computeKeyId } from "./qredSealer.js";
import { decodeSeal, verifyQRedSeals } from "./qredVerifier.js";
import { attestationMessage, pageCommitment } from "./attestation.js";
import { bytesToHex, concatenate, decodeBase64Url, encodeBase64Url, encodeEnvelope, sealString, sha256 } from "./sealFormat.js";
import { evidenceBodyBudget, planPageEvidence } from "./pdf/pageEvidencePlan.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";
const pageContext = { pageNumber: 1, pageCount: 1 };
const visual = { codebook: 1, columns: 2, rows: 2, indices: new Uint8Array([0, 15, 5, 10]) };
const base = { text: "Account 123456\n\nTotal 50.00", width: 612, height: 792, visual };
const lines = [{ x: 0.15, y: 0.2, width: 0.3, height: 0.02 }, { x: 0.3, y: 0.5, width: 0.2, height: 0.02 }];
const image = { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4).fill(255) };
for (let y = 2; y < 12; y++) for (let x = 3; x < 7; x++) image.data.fill(0, (y * 16 + x) * 4, (y * 16 + x) * 4 + 3);

describe("signed binary page references", () => {
  it("signs encoder and worker byte views without treating them as comma-separated text", () => {
    const metadata = { timestamp: "2026-10-23T12:00:00Z", key_id: "1234567890abcdef" };
    const foreign = runInNewContext("new Uint8Array([65, 66, 67])");
    expect(foreign instanceof Uint8Array).toBe(false);
    expect(sealSignatureMessage(metadata, foreign)).toEqual(sealSignatureMessage(metadata, "ABC"));
    expect(() => sealSignatureMessage(metadata, { length: 3 })).toThrow("Invalid signed content");
  });
  it.each([1, 2, 3])("round-trips text, visual data, and mode %s line positions", mode => {
    const bytes = encodePageEvidence({ ...base, layout: { mode, lines } });
    const decoded = decodePageEvidence(bytes);
    expect(decoded).toMatchObject({ text: base.text, width: 612, height: 792, visual });
    expect(decoded.layout.lines).toHaveLength(2);
    const error = mode === 1 ? 1 / 16 : mode === 2 ? 1 / 255 : 1 / 65535;
    decoded.layout.lines.forEach((line, index) => {
      expect(Math.abs(line.x - lines[index].x)).toBeLessThanOrEqual(error);
      expect(Math.abs(line.y - lines[index].y)).toBeLessThanOrEqual(error);
    });
    expect(encodePageEvidence({ ...decoded, layout: { mode, lines: decoded.layout.lines } })).toEqual(bytes);
  });
  it("stores blank pages in seven bytes and distinguishes them from images", () => {
    const bytes = encodePageEvidence({ width: 612, height: 792, blank: true });
    expect(bytes.length).toBe(7);
    expect(decodePageEvidence(bytes)).toMatchObject({ text: "", blank: true, visual: null });
    expect(decodePageEvidence(encodePageEvidence({ width: 612, height: 792, visual }))).toMatchObject({ text: "", blank: false, visual });
    expect(() => encodePageEvidence({ width: 612, height: 792 })).toThrow();
    expect(() => encodePageEvidence({ ...base, blank: true })).toThrow();
  });
  it("rejects truncation, trailing bytes, unknown codebooks, invalid dimensions and excessive grids", () => {
    const body = encodePageEvidence({ width: 612, height: 792, visual });
    for (let size = 0; size < body.length; size++) expect(() => decodePageEvidence(body.subarray(0, size))).toThrow();
    for (const [offset, value] of [[0, 2], [1, 32], [7, 2], [8, 0], [8, 255], [9, 255]]) {
      const invalid = body.slice(); invalid[offset] = value;
      expect(() => decodePageEvidence(invalid)).toThrow();
    }
    expect(() => decodePageEvidence(concatenate([body, new Uint8Array([0])]))).toThrow();
    expect(() => encodePageEvidence({ ...base, layout: { mode: 1, lines: [] } })).toThrow();
  });
  it("reconstructs real pixel blocks from one-byte vector indices", () => {
    expect(CODEBOOK).toHaveLength(256);
    const ref = encodeVisualReference(image, 4, 4), restored = renderVisualReference(ref);
    expect(ref.indices.length).toBe(16);
    expect(restored.width).toBe(16);
    let error = 0;
    for (let i = 0; i < restored.data.length; i += 4) error += Math.abs(restored.data[i] - image.data[i]);
    expect(error / 256).toBeLessThan(20);
    expect(new Set(ref.indices).size).toBeGreaterThan(1);
  });
  it("pins the offline dictionary so future edits cannot silently change signed references", async () => {
    expect(bytesToHex(await sha256(concatenate(CODEBOOK)))).toBe("f5bb64d5163a2409c9c90cc8b8c40877b89896fc81bdb0666b0a452245ddc570");
  });
  it.each(["plaintext", "zlib", "gzip"])("signs and verifies a binary visual record with %s framing", async encodingStrategy => {
    const pageEvidence = encodePageEvidence({ ...base, layout: { mode: 1, lines } });
    const sealed = await createQRedSeals({ content: base.text, pageEvidence, pageContext, privateKey, publicKey, encodingStrategy });
    expect(sealed.seals).toHaveLength(1);
    const verified = await verifyQRedSeals(sealed.seals, publicKey);
    expect(verified).toMatchObject({ status: "VALID", content: base.text, evidence: { visual, layout: { mode: 1 } } });
    expect(verified.page_hash).toBe(bytesToHex(await sha256(pageEvidence)));
  });
  it("rejects changes to the image, positions, dimensions, or blank marker", async () => {
    for (const record of [{ ...base, layout: { mode: 1, lines } }, { width: 612, height: 792, blank: true }]) {
      const pageEvidence = encodePageEvidence(record);
      const sealed = await createQRedSeals({ content: record.text || "", pageEvidence, pageContext, privateKey, publicKey, encodingStrategy: "plaintext" });
      const decoded = decodeSeal(sealed.seals[0]);
      const altered = decodePageEvidence(decoded.data);
      const changes = [{ ...altered, width: 600 }];
      if (altered.visual) {
        changes.push({ ...altered, visual: { ...visual, indices: new Uint8Array([15, 0, 10, 5]) } });
        changes.push({ ...altered, layout: { mode: 1, lines: [...lines].reverse() } });
      } else changes.push({ ...altered, blank: false, visual });
      for (const change of changes) {
        const forged = sealString(encodeEnvelope(decoded, decoded.signature, encodePageEvidence(change), "plaintext"));
        expect((await verifyQRedSeals([forged], publicKey)).status).toBe("INVALID");
      }
    }
  });
  it("binds the page-body flag and all image bytes in Google commitments", async () => {
    const key_id = await computeKeyId(publicKey);
    const identity = { provider: "google", name_source: "google", email: "test@example.com", name: "Example", subject: "123" };
    const metadata = { pdf: true, page_number: 1, page_count: 1, page_evidence: true,
      timestamp: "2026-10-23T12:00:00.000Z", key_id, identity };
    const body = encodePageEvidence({ width: 612, height: 792, visual });
    const commitment = await pageCommitment(metadata, body);
    expect(commitment).not.toEqual(await pageCommitment({ ...metadata, page_evidence: false }, body));
    const signature = await signAsync(attestationMessage(metadata, commitment), decodeBase64Url(privateKey));
    const sealed = await createQRedSeals({ content: "", pageEvidence: body, pageContext,
      attestation: { ...metadata, signature: encodeBase64Url(signature), public_key: publicKey } });
    const verified = await verifyQRedSeals(sealed.seals, "", { [key_id]: publicKey });
    expect(verified).toMatchObject({ status: "VALID", content: "", identity_authenticated: true, evidence: { visual } });
  });
});

describe("optional evidence budget", () => {
  it("never increases the text's QR count, including unknown Google identity sizes", () => {
    const count = size => size <= 2945 ? 1 : Math.ceil(size / 2921);
    for (const attested of [false, true]) for (const multiple of [false, true]) {
      const baseHeader = 83 + (multiple ? 20 : 0);
      for (let length = 1; length < 5800; length += 13) {
        const budget = evidenceBodyBudget(length, { attested, multiple });
        if (!budget) continue;
        for (const identitySize of attested ? [16, 150, 360, 673] : [0]) {
          expect(count(budget + baseHeader + identitySize)).toBeLessThanOrEqual(count(length + baseHeader + identitySize));
          expect(count(budget + baseHeader + identitySize)).toBeLessThanOrEqual(2);
        }
      }
    }
  });
  it("spends spare space on positions and a thumbnail without adding a QR", async () => {
    const plan = await planPageEvidence({ ...base, lines, image, blank: false }, { encodingStrategy: "plaintext" });
    const evidence = decodePageEvidence(plan.body);
    expect(evidence.layout.mode).toBe(3);
    expect(evidence.visual.indices.length).toBeGreaterThan(1000);
    expect(plan.body.length + 83).toBeLessThanOrEqual(2945);
    const sealed = await createQRedSeals({ content: base.text, pageEvidence: plan.body, pageContext, privateKey, publicKey, encodingStrategy: "plaintext" });
    expect(sealed.seals).toHaveLength(1);
  });
  it("omits optional evidence at a capacity boundary and rejects a third PDF code", async () => {
    const text = "x".repeat(2860);
    const plan = await planPageEvidence({ ...base, text, lines: [], image, blank: false }, { encodingStrategy: "plaintext" });
    expect(plan.pageEvidence).toBeNull();
    const sealed = await createQRedSeals({ content: text, pageContext, privateKey, publicKey, encodingStrategy: "plaintext" });
    expect(sealed.seals).toHaveLength(1);
    await expect(createQRedSeals({ content: "x".repeat(6000), pageContext, privateKey, publicKey, encodingStrategy: "plaintext" })).rejects.toThrow("two-QR limit");
  });
});
