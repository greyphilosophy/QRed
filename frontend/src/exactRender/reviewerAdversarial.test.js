import { beforeAll, describe, expect, it, vi } from "vitest";
import { signAsync } from "@noble/ed25519";
import { decodePageEvidence } from "../pageEvidence.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { encodeErasureChunks } from "../erasureTransport.js";
import { computeKeyId, sealSignatureMessage } from "../sealSignature.js";
import { decodeBase64Url, encodeEnvelope, sealString } from "../sealFormat.js";
import { assertWhiteRegions, compareExactPixels, decodeExactEvidence, encodeExactEvidence, exactDocumentRoot,
  EXACT_STYLE, MAX_EXACT_BODY_BYTES, rasterHash, validateExactImage, validateExactManifest } from "./evidence.js";
import { authenticateExactRecord } from "./record.js";

// Independent synthetic data only. No original private document is needed here.
const profile = "qred-exact-review-procedure-v1";
const keys = { privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=", publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=" };
const clone = value => structuredClone(value);
const white = () => ({ width: 800, height: 800, data: new Uint8ClampedArray(800 * 800 * 4).fill(255) });
const at = (x, y, channel = 0) => (y * 800 + x) * 4 + channel;
const rawBody = text => new Uint8Array([3, ...new TextEncoder().encode(text)]);
async function signedBody(body, { metadata: changed = {}, corruptSignature = false, encoding = "plaintext" } = {}) {
  const metadata = { version: "3", timestamp: "2026-11-04T07:00:00Z", key_id: await computeKeyId(keys.publicKey),
    pdf: true, page_evidence: true, page_number: 1, page_count: 1, document_root: null, ...changed };
  const signature = await signAsync(sealSignatureMessage(metadata, body), decodeBase64Url(keys.privateKey));
  if (corruptSignature) signature[0] ^= 1;
  return (await encodeErasureChunks(encodeEnvelope(metadata, signature, body, encoding))).map(bytes => sealString(bytes));
}
let source, overlay, observed, manifest, signedSeals;
beforeAll(async () => {
  source = white(); source.data[at(790, 790)] = 17;
  overlay = white();
  const boxes = Array.from({ length: 16 }, (_, index) => [5 + index % 4 * 185, 5 + Math.floor(index / 4) * 185, 173, 173]);
  for (const [x, y] of boxes) overlay.data.fill(217, at(x + 8, y + 8), at(x + 8, y + 8) + 3);
  observed = clone(source);
  for (const [x, y] of boxes) observed.data.fill(217, at(x + 8, y + 8), at(x + 8, y + 8) + 3);
  manifest = { type: "QRED-EXACT-RENDER", version: 1, profile, style: EXACT_STYLE, width: 800, height: 800,
    scale: 2, rotation: 0, userUnit: 1, bounds: [0, 0, 400, 400], page: 1, pages: 1,
    sourceSha256: await rasterHash(source.data), documentRoot: "0".repeat(64), required: 12, total: 16, boxes };
  manifest.documentRoot = await exactDocumentRoot([manifest], profile);
  const metadata = { version: "3", timestamp: "2026-11-04T07:00:00Z", key_id: await computeKeyId(keys.publicKey),
    pdf: true, page_evidence: true, page_number: 1, page_count: 1, document_root: null };
  const body = encodeExactEvidence(manifest, profile);
  const signature = await signAsync(sealSignatureMessage(metadata, body), decodeBase64Url(keys.privateKey));
  signedSeals = (await encodeErasureChunks(encodeEnvelope(metadata, signature, body, "plaintext"))).map(bytes => sealString(bytes));
});

describe("independent signature-first record review", () => {
  const authenticate = (seals, publicKey = keys.publicKey, expectedProfile = profile) =>
    authenticateExactRecord(seals, publicKey, { profile: expectedProfile });
  it("authenticates exactly recovered signed bytes, with no original PDF or source raster input", async () => {
    const result = await authenticate(signedSeals);
    expect(result.signatureStatus).toBe("VALID"); expect(result.manifest).toEqual(manifest);
    expect(await authenticate(signedSeals.slice(4))).toMatchObject({ signatureStatus: "VALID", manifest });
    expect(await authenticate([...signedSeals].reverse())).toMatchObject({ signatureStatus: "VALID", manifest });
  });
  it("does not parse even malformed evidence before a bad signature has failed", async () => {
    const seals = await signedBody(rawBody("{invalid-json"), { corruptSignature: true });
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(await authenticate(seals)).toEqual({ signatureStatus: "INVALID", reason: "signature-failed" });
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });
  it("reports authenticated malformed content separately from a failed signature without returning a manifest", async () => {
    const result = await authenticate(await signedBody(rawBody("{invalid-json")));
    expect(result).toEqual({ signatureStatus: "VALID", reason: "unsupported-or-invalid-exact-evidence" });
    expect(result).not.toHaveProperty("manifest");
  });
  it.each(["", keys.privateKey, "malformed-public-key"])("never returns interpreted evidence without the correct trusted key %s", async key => {
    const result = await authenticate(signedSeals, key);
    expect(result.signatureStatus).not.toBe("VALID"); expect(result).not.toHaveProperty("manifest");
  });
  it("refuses a wrong locally selected renderer profile even with a valid signature", async () => {
    const result = await authenticate(signedSeals, keys.publicKey, `${profile}/other`);
    expect(result).toEqual({ signatureStatus: "VALID", reason: "unsupported-or-invalid-exact-evidence" });
  });
  it("does not accept signed envelope page count or position that disagrees with the signed body", async () => {
    const body = encodeExactEvidence(manifest, profile);
    for (const page_number of [1, 2]) {
      const seals = await signedBody(body, { metadata: { page_number, page_count: 2, document_root: manifest.documentRoot } });
      expect(await authenticate(seals)).toEqual({ signatureStatus: "VALID", reason: "manifest-metadata-mismatch" });
    }
  });
  it("does not accept a signed envelope root different from a multipage manifest root", async () => {
    const body = encodeExactEvidence({ ...manifest, pages: 2 }, profile);
    const seals = await signedBody(body, { metadata: { page_count: 2, document_root: "1".repeat(64) } });
    expect(await authenticate(seals)).toEqual({ signatureStatus: "VALID", reason: "manifest-metadata-mismatch" });
  });
  it("does not recover from too few shards or silently drop foreign or duplicate observations", async () => {
    expect(await authenticate(signedSeals.slice(5))).toEqual({ signatureStatus: "INCOMPLETE", reason: "insufficient-seals" });
    const foreign = await signedBody(encodeExactEvidence({ ...manifest, sourceSha256: "2".repeat(64) }, profile));
    for (const seals of [[...signedSeals.slice(0, 12), foreign[15]], [...signedSeals.slice(0, 12), signedSeals[0]]])
      expect(await authenticate(seals)).toEqual({ signatureStatus: "INVALID", reason: "invalid-seal-record" });
  });
  it("keeps ordinary prose and non-page envelopes out of exact evidence", async () => {
    const prose = new TextEncoder().encode("Ordinary prose is not a raster manifest.");
    expect(await authenticate(await signedBody(prose))).toEqual({ signatureStatus: "VALID", reason: "unsupported-or-invalid-exact-evidence" });
    expect(await authenticate(await signedBody(prose, { metadata: { pdf: false, page_evidence: false } })))
      .toEqual({ signatureStatus: "UNSUPPORTED", reason: "unsupported-exact-envelope" });
  });
  it("rejects compressed envelopes without invoking a decompressor", async () => {
    const compressed = await signedBody(encodeExactEvidence(manifest, profile), { encoding: "zlib" });
    expect(await authenticate(compressed)).toEqual({ signatureStatus: "UNSUPPORTED", reason: "unsupported-exact-envelope" });
  });
  it("rejects attacker-sized collections and signed bodies before manifest parsing", async () => {
    for (const seals of [Array(17).fill(signedSeals[0]), ["x".repeat(8193)], null])
      expect(await authenticate(seals)).toEqual({ signatureStatus: "UNSUPPORTED", reason: "invalid-seal-collection" });
    const overlong = await signedBody(new Uint8Array(MAX_EXACT_BODY_BYTES + 1).fill(3));
    expect(await authenticate(overlong)).toEqual({ signatureStatus: "UNSUPPORTED", reason: "unsupported-exact-envelope" });
  });
});

describe("independent exact-evidence wire review", () => {
  it("round-trips a distinct body but legacy readers refuse it instead of treating it as OCR", async () => {
    const body = encodeExactEvidence(manifest, profile);
    expect(body[0]).toBe(3);
    expect(decodeExactEvidence(body, profile)).toEqual(manifest);
    expect(() => decodePageEvidence(body)).toThrow("Unsupported page evidence format");
    expect(await verifyQRedSeals(signedSeals, keys.publicKey)).toMatchObject({ status: "ERROR" });
  });
  it.each([
    ["unknown field", m => { m.mask = [[0, 0, 800, 800]]; }],
    ["wrong domain", m => { m.type = "QRED-EXACT-RENDER-EXPERIMENT"; }],
    ["wrong version", m => { m.version = 2; }],
    ["wrong profile", m => { m.profile += "/wrong"; }],
    ["wrong style", m => { m.style += "/wrong"; }],
    ["fractional width", m => { m.width += 0.5; }],
    ["too many pixels", m => { m.width = 3_000_001; }],
    ["negative width", m => { m.width = -1; }],
    ["different scale", m => { m.scale = 1; }],
    ["rotation", m => { m.rotation = 90; }],
    ["custom user unit", m => { m.userUnit = 2; }],
    ["different crop", m => { m.bounds[0] = 1; }],
    ["page zero", m => { m.page = 0; }],
    ["page beyond count", m => { m.page = 2; }],
    ["page limit", m => { m.pages = 101; }],
    ["short source hash", m => { m.sourceSha256 = "00"; }],
    ["nonhex root", m => { m.documentRoot = "z".repeat(64); }],
    ["wrong threshold", m => { m.required = 11; }],
    ["wrong shard count", m => { m.total = 15; }],
    ["missing rectangle", m => { m.boxes.pop(); }],
    ["null rectangle", m => { m.boxes[0] = null; }],
    ["negative rectangle", m => { m.boxes[0][0] = -1; }],
    ["fractional rectangle", m => { m.boxes[0][1] += 0.5; }],
    ["overflow rectangle", m => { m.boxes[0][0] = 700; }],
    ["larger exclusion", m => { m.boxes[0][2] += 1; }],
    ["overlap", m => { m.boxes[1] = [...m.boxes[0]]; }],
  ])("rejects %s", (_label, alter) => {
    const changed = clone(manifest); alter(changed);
    expect(() => decodeExactEvidence(rawBody(JSON.stringify(changed)), profile)).toThrow();
  });
  it.each(["null", "true", "[]", "5", "{}", "{", "\ufeff{}"])("rejects malformed or primitive JSON %s", text => {
    expect(() => decodeExactEvidence(rawBody(text), profile)).toThrow();
  });
  it("rejects duplicate keys, noncanonical whitespace, trailing data, invalid UTF-8, and length overflow", () => {
    const text = JSON.stringify(manifest);
    for (const value of [text.replace('{"type":', '{"version":1,"type":'), ` ${text}`, `${text} `, `${text}{}`])
      expect(() => decodeExactEvidence(rawBody(value), profile)).toThrow();
    expect(() => decodeExactEvidence(new Uint8Array([3, 0xff]), profile)).toThrow();
    expect(() => decodeExactEvidence(new Uint8Array(MAX_EXACT_BODY_BYTES + 1).fill(3), profile)).toThrow();
    expect(() => validateExactManifest(manifest, "unregistered")).toThrow();
  });
});

describe("independent complete-pixel coverage review", () => {
  it("passes with only observation, authenticated manifest, and independently regenerated artwork", async () => {
    expect(await compareExactPixels(observed, manifest, overlay, profile)).toEqual({ status: "exact-render-match", reason: "every-pixel-covered" });
  });
  it.each([
    ["quiet zone RGB", 5, 5, 0], ["quiet zone alpha", 5, 5, 3],
    ["dark module RGB", 13, 13, 0], ["dark module alpha", 13, 13, 3],
    ["last rectangle pixel", 177, 177, 2],
  ])("refuses any changed authenticated stamp byte: %s", async (_label, x, y, channel) => {
    const changed = clone(observed); changed.data[at(x, y, channel)]--;
    expect(await compareExactPixels(changed, manifest, overlay, profile)).toEqual({ status: "inconclusive", reason: "seal-pixels-mismatch" });
  });
  it.each([[4, 5, 0], [178, 5, 0], [5, 4, 0], [5, 178, 0], [0, 0, 3], [790, 790, 0], [799, 799, 2]])(
    "hashes source byte immediately outside masks or at page boundary %i,%i,%i", async (x, y, channel) => {
      const changed = clone(observed); changed.data[at(x, y, channel)]--;
      expect(await compareExactPixels(changed, manifest, overlay, profile)).toEqual({ status: "inconclusive", reason: "source-pixels-mismatch" });
    });
  it("does not accept an unchecked regenerated-overlay pixel outside the signed rectangles", async () => {
    const changed = clone(overlay); changed.data[at(799, 799)] = 254;
    await expect(compareExactPixels(observed, manifest, changed, profile)).rejects.toThrow("outside authenticated rectangles");
  });
  it("does not tolerate a whole erased symbol even if transport could recover its data", async () => {
    const changed = clone(observed); changed.data.fill(255, at(13, 13), at(13, 13) + 3);
    expect(await compareExactPixels(changed, manifest, overlay, profile)).toMatchObject({ status: "inconclusive", reason: "seal-pixels-mismatch" });
  });
  it("does not mutate the observation or regenerate artwork from the observation", async () => {
    const original = await rasterHash(observed.data), expected = await rasterHash(overlay.data);
    await compareExactPixels(observed, manifest, overlay, profile);
    expect(await rasterHash(observed.data)).toBe(original); expect(await rasterHash(overlay.data)).toBe(expected);
  });
  it("does not confuse equal RGBA byte counts with equal geometry", async () => {
    const changed = { ...observed, width: 1600, height: 400 };
    expect(await compareExactPixels(changed, manifest, overlay, profile)).toMatchObject({ status: "inconclusive", reason: "geometry-mismatch" });
  });
  it("rejects invalid image dimensions, missing bytes, and wider channel types", () => {
    for (const image of [{ ...observed, width: 0 }, { ...observed, width: Infinity },
      { ...observed, data: observed.data.subarray(1) }, { ...observed, data: new Uint16Array(800 * 800 * 2) },
      { ...observed, width: 3_000_001, height: 1 }]) expect(() => validateExactImage(image)).toThrow();
  });
  it("requires every source stamp and guard channel to be pure white, including faint RGB and alpha", () => {
    expect(() => assertWhiteRegions(source, manifest.boxes)).not.toThrow();
    for (const offset of [at(5, 5), at(1, 1), at(181, 181), at(5, 5, 3)]) {
      const changed = clone(source); changed.data[offset] = 254;
      expect(() => assertWhiteRegions(changed, manifest.boxes)).toThrow();
    }
  });
  it("binds the document root to profile, source hash order, geometry, and complete page count", async () => {
    const other = { ...manifest, sourceSha256: "1".repeat(64) };
    const root = await exactDocumentRoot([manifest, other], profile);
    for (const [pages, expectedProfile] of [[[other, manifest], profile], [[manifest], profile],
      [[manifest, { ...other, width: 801 }], profile], [[manifest, other], `${profile}/changed`]])
      expect(await exactDocumentRoot(pages, expectedProfile)).not.toBe(root);
  });
});
