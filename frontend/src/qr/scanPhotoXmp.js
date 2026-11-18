import { MAX_SCAN_METADATA_BYTES, normalizeScanMetadata } from "./scanPhotoMetadata.js";

const XMP_HEADER = "http://ns.adobe.com/xap/1.0/\0";
const QRED_NS = "https://qred.org/ns/scan/1.0/";
const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const MAX_HEADER = 1024 * 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder();

function orientation(bytes) {
  // Read only the primary TIFF orientation. Preserve the whole EXIF segment.
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = view.getUint16(6) === 0x4949;
    if (!little && view.getUint16(6) !== 0x4d4d) return null;
    if (view.getUint16(8, little) !== 42) return null;
    const ifd = 6 + view.getUint32(10, little), count = view.getUint16(ifd, little);
    if (ifd < 14 || count > 1024 || ifd + 2 + count * 12 > bytes.length) return null;
    for (let n = 0; n < count; n++) {
      const at = ifd + 2 + n * 12;
      if (view.getUint16(at, little) === 0x112 && view.getUint16(at + 2, little) === 3
        && view.getUint32(at + 4, little) === 1) {
        const value = view.getUint16(at + 8, little);
        return value >= 1 && value <= 8 ? value : null;
      }
    }
  } catch { /* Truncated/unrecognized EXIF is not a capture failure. */ }
  return null;
}

async function jpegHeader(photo) {
  const bytes = new Uint8Array(await photo.slice(0, MAX_HEADER).arrayBuffer());
  if (bytes[0] !== 255 || bytes[1] !== 216) return null;
  const result = { xmp: [], insert: 2, encodedSize: null, exifOrientation: null, compound: false };
  let at = 2;
  while (at + 4 <= bytes.length) {
    const start = at;
    if (bytes[at++] !== 255) return null;
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (marker === 0xda || marker === 0xd9) return result;
    if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return null;
    if (marker === 1) continue;
    const length = (bytes[at] << 8) | bytes[at + 1], end = at + length;
    if (length < 2 || end > bytes.length) return null;
    const payload = bytes.subarray(at + 2, end);
    if (marker === 0xe0 || marker === 0xe1) result.insert = end;
    if (marker === 0xe1 && decoder.decode(payload.subarray(0, XMP_HEADER.length)) === XMP_HEADER)
      result.xmp.push({ start, end, xml: decoder.decode(payload.subarray(XMP_HEADER.length)) });
    if (marker === 0xe1 && decoder.decode(payload.subarray(0, 6)) === "Exif\0\0")
      result.exifOrientation = orientation(payload);
    // MPF/HDR/motion-photo containers can have byte offsets into appended data.
    // Keep their file bytes unchanged and use the ZIP sidecar instead.
    if (marker === 0xe2 && decoder.decode(payload.subarray(0, 4)) === "MPF\0") result.compound = true;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && payload.length >= 5)
      result.encodedSize = { width: (payload[3] << 8) | payload[4], height: (payload[1] << 8) | payload[2] };
    at = end;
  }
  return null;
}

function parseXmp(xml) {
  if (typeof DOMParser === "undefined" || /<!DOCTYPE|<!ENTITY/i.test(xml)) return null;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length || doc.doctype) return null;
  return doc.getElementsByTagNameNS(RDF_NS, "RDF").length === 1 ? doc : null;
}

export async function readScanPhotoXmp(photo) {
  try {
    const header = await jpegHeader(photo);
    if (header?.xmp.length !== 1) return null;
    const doc = parseXmp(header.xmp[0].xml);
    const items = doc?.getElementsByTagNameNS(QRED_NS, "Capture");
    if (items?.length !== 1 || items[0].textContent.length > MAX_SCAN_METADATA_BYTES) return null;
    return normalizeScanMetadata(JSON.parse(items[0].textContent));
  } catch { return null; }
}

// Adds/merges a standard JPEG APP1 XMP packet without decoding or recompressing
// pixels. Existing EXIF and other segments are retained byte for byte.
export async function writeScanPhotoXmp(photo, value) {
  let metadata = normalizeScanMetadata(value);
  if (!metadata) return { photo, metadata: null, embedded: false };
  try {
    const header = await jpegHeader(photo);
    if (!header) return { photo, metadata, embedded: false };
    metadata = normalizeScanMetadata({ ...metadata,
      image: { ...metadata.image, encodedSize: header.encodedSize, exifOrientation: header.exifOrientation } });
    const unchanged = { photo, metadata, embedded: false };
    const tail = new Uint8Array(await photo.slice(-2).arrayBuffer());
    // Unknown appended trailers may also contain offsets (for example Samsung
    // motion-photo data). Only modify a JPEG ending at its own EOI marker.
    if (tail[0] !== 255 || tail[1] !== 217) return unchanged;
    if (header.compound || header.xmp.length > 1 || header.xmp.some(item => /MotionPhoto|MicroVideo|GainMap|Container:Directory/.test(item.xml))) return unchanged;
    const old = header.xmp[0];
    const doc = parseXmp(old?.xml || `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}"/></x:xmpmeta>`);
    if (!doc || typeof XMLSerializer === "undefined") return unchanged;
    const rdf = doc.getElementsByTagNameNS(RDF_NS, "RDF")[0];
    const previous = [...doc.getElementsByTagNameNS(QRED_NS, "Capture")];
    let field = previous.shift();
    for (const item of previous) item.remove();
    if (!field) {
      const description = doc.createElementNS(RDF_NS, "rdf:Description");
      description.setAttributeNS(RDF_NS, "rdf:about", "");
      field = doc.createElementNS(QRED_NS, "qred:Capture");
      description.appendChild(field); rdf.appendChild(description);
    }
    field.textContent = JSON.stringify(metadata);
    const packet = encoder.encode(XMP_HEADER + new XMLSerializer().serializeToString(doc));
    if (packet.length + 2 > 65535) return unchanged;
    const segment = new Uint8Array(packet.length + 4);
    segment.set([255, 225, (packet.length + 2) >> 8, (packet.length + 2) & 255]); segment.set(packet, 4);
    const start = old?.start ?? header.insert, end = old?.end ?? start;
    return { photo: new Blob([photo.slice(0, start), segment, photo.slice(end)], { type: photo.type }), metadata, embedded: true };
  } catch { return { photo, metadata, embedded: false }; }
}
