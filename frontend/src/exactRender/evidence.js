import { bytesToHex, concatenate, sha256, strictUtf8, utf8 } from "../sealFormat.js";

// A separate page-body version. Existing readers reject it rather than treating
// machine evidence as signed prose. This module never interprets ordinary text.
export const EXACT_BODY_VERSION = 3;
export const MAX_EXACT_BODY_BYTES = 4096;
export const MAX_EXACT_PIXELS = 3_000_000;
export const MAX_EXACT_PAGES = 100;
export const EXACT_SIDE = 173;
export const EXACT_STYLE = "qred-exact-qr-v1/M/quiet4/gray0.85/normal";
export const EXACT_SCOPE = "Exact equality of this 144 dpi rendered appearance to the signed raster, except for exactly authenticated seal artwork. Not PDF-byte, hidden-content, OCR, other-reader, or print/photo verification.";
const HASH = /^[0-9a-f]{64}$/;
const KEYS = ["type", "version", "profile", "style", "width", "height", "scale", "rotation", "userUnit", "bounds", "page", "pages", "sourceSha256", "documentRoot", "required", "total", "boxes"];

export async function rasterHash(bytes) { return bytesToHex(await sha256(bytes)); }
export function validateExactImage(image) {
  if (!Number.isInteger(image?.width) || !Number.isInteger(image?.height) || image.width < 1 || image.height < 1 ||
      image.width * image.height > MAX_EXACT_PIXELS || !ArrayBuffer.isView(image.data) || image.data.BYTES_PER_ELEMENT !== 1 ||
      image.data.byteLength !== image.width * image.height * 4) throw new Error("Unsupported exact-render raster");
}
export function validateExactManifest(m, profile) {
  if (typeof profile !== "string" || !profile.startsWith("qred-exact-") || !m || Object.getPrototypeOf(m) !== Object.prototype ||
      Object.keys(m).length !== KEYS.length || Object.keys(m).some(key => !KEYS.includes(key))) throw new Error("Invalid exact-render schema");
  if (m.type !== "QRED-EXACT-RENDER" || m.version !== 1 || m.profile !== profile || m.style !== EXACT_STYLE ||
      !Number.isInteger(m.width) || !Number.isInteger(m.height) || m.width < 1 || m.height < 1 || m.width * m.height > MAX_EXACT_PIXELS ||
      m.scale !== 2 || m.rotation !== 0 || m.userUnit !== 1 || !Array.isArray(m.bounds) || m.bounds.length !== 4 ||
      m.bounds.some((value, index) => value !== [0, 0, m.width / 2, m.height / 2][index]) ||
      !Number.isInteger(m.page) || !Number.isInteger(m.pages) || m.pages < 1 || m.pages > MAX_EXACT_PAGES || m.page < 1 || m.page > m.pages ||
      typeof m.sourceSha256 !== "string" || !HASH.test(m.sourceSha256) || typeof m.documentRoot !== "string" || !HASH.test(m.documentRoot) ||
      m.required !== 12 || m.total !== 16 || !Array.isArray(m.boxes) || m.boxes.length !== 16) throw new Error("Unsupported exact-render evidence or profile");
  m.boxes.forEach((box, index) => {
    if (!Array.isArray(box) || box.length !== 4 || box.some(value => !Number.isInteger(value)) ||
        box[2] !== EXACT_SIDE || box[3] !== EXACT_SIDE || box[0] < 0 || box[1] < 0 ||
        box[0] + box[2] > m.width || box[1] + box[3] > m.height) throw new Error("Invalid exact-render seal rectangle");
    for (const previous of m.boxes.slice(0, index)) if (box[0] < previous[0] + previous[2] && previous[0] < box[0] + box[2] &&
        box[1] < previous[1] + previous[3] && previous[1] < box[1] + box[3]) throw new Error("Overlapping exact-render seal rectangles");
  });
  return m;
}
export function encodeExactEvidence(manifest, profile) {
  validateExactManifest(manifest, profile);
  const body = concatenate([new Uint8Array([EXACT_BODY_VERSION]), utf8.encode(JSON.stringify(manifest))]);
  if (body.length > MAX_EXACT_BODY_BYTES) throw new Error("Exact-render evidence exceeds its limit");
  return body;
}
// Only call after authenticating the complete body and its envelope metadata.
export function decodeExactEvidence(body, profile) {
  if (!(body instanceof Uint8Array) || body.length < 2 || body.length > MAX_EXACT_BODY_BYTES || body[0] !== EXACT_BODY_VERSION)
    throw new Error("Unsupported exact-render evidence body");
  const text = strictUtf8.decode(body.subarray(1)), manifest = JSON.parse(text);
  if (JSON.stringify(manifest) !== text) throw new Error("Noncanonical exact-render evidence");
  return validateExactManifest(manifest, profile);
}
export async function exactDocumentRoot(pages, profile) {
  return rasterHash(utf8.encode(JSON.stringify({ domain: "QRed exact rendered document v1", profile,
    pages: pages.map(({ width, height, sourceSha256 }) => ({ width, height, sourceSha256 })) })));
}
export function assertWhiteRegions(image, boxes, guard = 4) {
  validateExactImage(image);
  for (const [x, y, width, height] of boxes) {
    if (x - guard < 0 || y - guard < 0 || x + width + guard > image.width || y + height + guard > image.height)
      throw new Error("Invalid source guard");
    for (let yy = y - guard; yy < y + height + guard; yy++) for (let xx = x - guard; xx < x + width + guard; xx++) {
      const offset = (yy * image.width + xx) * 4;
      for (let channel = 0; channel < 4; channel++) if (image.data[offset + channel] !== 255)
        throw new Error("Original source marks intersect a seal rectangle");
    }
  }
}
export async function compareExactPixels(observed, manifest, overlay, profile) {
  validateExactImage(observed); validateExactImage(overlay); validateExactManifest(manifest, profile);
  if (observed.width !== manifest.width || observed.height !== manifest.height || overlay.width !== manifest.width || overlay.height !== manifest.height)
    return { status: "inconclusive", reason: "geometry-mismatch" };
  const inside = new Uint8Array(manifest.width * manifest.height);
  for (const [x, y, width, height] of manifest.boxes) for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) {
    const pixel = yy * manifest.width + xx; inside[pixel] = 1;
    for (let channel = 0; channel < 4; channel++) if (observed.data[pixel * 4 + channel] !== overlay.data[pixel * 4 + channel])
      return { status: "inconclusive", reason: "seal-pixels-mismatch" };
  }
  for (let pixel = 0; pixel < inside.length; pixel++) if (!inside[pixel]) for (let channel = 0; channel < 4; channel++)
    if (overlay.data[pixel * 4 + channel] !== 255) throw new Error("Regenerated seal paints outside authenticated rectangles");
  // Never restore an exclusion rectangle until every one of its RGBA bytes
  // agrees with independent artwork regenerated from the authenticated record.
  const restored = new Uint8Array(observed.data);
  for (let pixel = 0; pixel < inside.length; pixel++) if (inside[pixel]) restored.fill(255, pixel * 4, pixel * 4 + 4);
  const matches = await rasterHash(restored) === manifest.sourceSha256;
  return { status: matches ? "exact-render-match" : "inconclusive", reason: matches ? "every-pixel-covered" : "source-pixels-mismatch" };
}
