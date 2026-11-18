import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import jpeg from "jpeg-js";
import { unzip } from "unzipit";
import { downloadZip } from "client-zip";
import { createCaptureMetadata, getScanPhotoMetadata, MAX_SCAN_METADATA_BYTES, normalizeScanMetadata,
  rememberScanMetadata, snapshotPhotoSettings } from "./scanPhotoMetadata.js";
import { readScanPhotoXmp, writeScanPhotoXmp } from "./scanPhotoXmp.js";
import { createScanPhotoArchive, readScanPhotoZip } from "./scanPhotoArchive.js";
import { readCameraPhotoFile } from "./cameraPhoto.js";

const dom = new JSDOM("");
beforeEach(() => {
  vi.stubGlobal("DOMParser", dom.window.DOMParser);
  vi.stubGlobal("XMLSerializer", dom.window.XMLSerializer);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const bytes = async blob => new Uint8Array(await blob.arrayBuffer());

function metadata() {
  return createCaptureMetadata(snapshotPhotoSettings({ getSettings: () => ({ zoom: 1.5, torch: true }) },
    { fillLightMode: "off", imageWidth: 16, imageHeight: 24 }),
  { sourceWidth: 24, sourceHeight: 16, width: 12, height: 8 },
  { trigger: "manual", previewWidth: 640, previewHeight: 480, guideState: "clear" });
}

function segment(marker, payload) {
  return new Uint8Array([255, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload]);
}

function photo(...segments) {
  const data = new Uint8Array(16 * 24 * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 17) % 256;
  const encoded = jpeg.encode({ width: 16, height: 24, data }, 90).data;
  return new Blob([encoded.subarray(0, 2), ...segments, encoded.subarray(2)], { type: "image/jpeg" });
}

const exif = segment(225, new Uint8Array([
  69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0,
  1, 0, 18, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
]));
const xmp = xml => segment(225, new TextEncoder().encode("http://ns.adobe.com/xap/1.0/\0" + xml));
const zip = entries => downloadZip(entries.map(([name, input]) => ({ name, input }))).blob();

it("copies only reported capture settings and marks unavailable settings unknown", () => {
  const reported = { zoom: 1.2, torch: true, focusMode: "continuous", deviceId: "private-device", groupId: "private-group",
    label: "private-camera", gps: "private-location", exposureTime: Infinity };
  const snapshot = snapshotPhotoSettings({ getSettings: () => reported }, { fillLightMode: "off" });
  reported.zoom = 2; reported.torch = false;
  expect(snapshot.trackSettings).toMatchObject({ zoom: 1.2, torch: true, focusMode: "continuous", exposureTime: null, iso: null });
  expect(JSON.stringify(snapshot)).not.toContain("private");
  const unsupported = snapshotPhotoSettings({ getSettings() { throw new Error("Unsupported"); } }, {});
  expect(Object.values(unsupported.trackSettings).every(value => value === null)).toBe(true);
  expect(metadata()).toMatchObject({ app: { version: "0.1.0", build: expect.any(String) }, calibration: null,
    processing: { savedPixels: "camera-original", cameraLensCorrection: "unknown", qredLensCorrection: "not-applied",
      decoderInput: { width: 12, height: 8 }, decoderCrop: null } });
});

it("round-trips JPEG XMP without changing decoded pixels or EXIF and does not accumulate packets", async () => {
  const original = photo(exif);
  const saved = await writeScanPhotoXmp(original, metadata());
  expect(saved.embedded).toBe(true);
  expect(saved.metadata.image).toEqual({ encodedSize: { width: 16, height: 24 }, decodedSize: { width: 24, height: 16 }, exifOrientation: 6 });
  const encoded = await bytes(saved.photo), native = await bytes(original);
  expect(jpeg.decode(encoded)).toEqual(jpeg.decode(native));
  expect([...encoded.subarray(2, 2 + exif.length)]).toEqual([...exif]);
  expect(await readScanPhotoXmp(saved.photo)).toEqual(saved.metadata);
  const again = await writeScanPhotoXmp(saved.photo, saved.metadata);
  expect(again.photo.size).toBe(saved.photo.size);
  expect(await readScanPhotoXmp(again.photo)).toEqual(saved.metadata);
});

it("merges existing XMP while preserving unrelated native properties", async () => {
  const original = photo(xmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:description>Camera &amp; original</dc:description></rdf:Description></rdf:RDF></x:xmpmeta>'));
  const saved = await writeScanPhotoXmp(original, metadata());
  expect(saved.embedded).toBe(true);
  expect(await saved.photo.text()).toContain("Camera &amp; original");
  expect((await saved.photo.text()).split("http://ns.adobe.com/xap/1.0/").length).toBe(2);
  expect(jpeg.decode(await bytes(saved.photo))).toEqual(jpeg.decode(await bytes(original)));
});

it("uses sidecar-only metadata for compound JPEGs or malformed/oversized native XMP", async () => {
  const originals = [
    photo(segment(226, new TextEncoder().encode("MPF\0offsets"))),
    new Blob([photo(), "appended camera trailer"], { type: "image/jpeg" }),
    photo(xmp("<broken>")),
    photo(xmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' + " ".repeat(65000) + '</rdf:RDF></x:xmpmeta>')),
  ];
  for (const original of originals) {
    const saved = await writeScanPhotoXmp(original, metadata());
    expect(saved.embedded).toBe(false);
    expect(saved.photo).toBe(original);
    expect(saved.metadata.capture.trackSettings.zoom).toBe(1.5);
  }
});

it("saves matching JPEG and JSON metadata and restores it from a new ZIP", async () => {
  const original = photo(exif);
  rememberScanMetadata(original, metadata());
  const archive = await createScanPhotoArchive(original), { entries } = await unzip(archive);
  expect(Object.keys(entries)).toEqual(["exposure-01.jpg", "qred-scan.json"]);
  const manifest = await entries["qred-scan.json"].json();
  expect(manifest.photos[0].embeddedXmp).toBe(true);
  const restored = await readScanPhotoZip(archive);
  expect(getScanPhotoMetadata(restored)).toEqual(manifest.photos[0].metadata);
  expect(await readScanPhotoXmp(restored)).toEqual(manifest.photos[0].metadata);
  expect(jpeg.decode(await bytes(restored))).toEqual(jpeg.decode(await bytes(original)));
});

it("retains non-JPEG bytes exactly and restores their metadata from the sidecar", async () => {
  const original = new Blob([new Uint8Array([137, 80, 78, 71, 0, 1, 2])], { type: "image/png" });
  const captured = metadata();
  rememberScanMetadata(original, captured);
  const archive = await createScanPhotoArchive(original), { entries } = await unzip(archive);
  expect((await entries["qred-scan.json"].json()).photos[0].embeddedXmp).toBe(false);
  const restored = await readScanPhotoZip(archive);
  expect(await bytes(restored)).toEqual(await bytes(original));
  expect(getScanPhotoMetadata(restored)).toEqual(captured);
});

it.each(["malformed", "oversized", "wrong-photo", "wrong-version", "wrong-folder", "duplicate"])(
  "opens the photo when optional sidecar metadata is %s", async kind => {
    const manifest = { schema: "qred-scan-archive", version: kind === "wrong-version" ? 2 : 1,
      photos: [{ name: kind === "wrong-photo" ? "exposure-02.jpg" : "exposure-01.jpg", metadata: metadata() }] };
    const text = kind === "malformed" ? "not JSON" : kind === "oversized" ? " ".repeat(MAX_SCAN_METADATA_BYTES + 1) : JSON.stringify(manifest);
    const entries = [["exposure-01.jpg", "image"], [kind === "wrong-folder" ? "other/qred-scan.json" : "qred-scan.json", text]];
    if (kind === "duplicate") entries.push(["other/qred-scan.json", text]);
    const restored = await readScanPhotoZip(await zip(entries));
    expect(await restored.text()).toBe("image");
    expect(getScanPhotoMetadata(restored)).toBeNull();
  });

it("ignores arbitrary imported fields and malformed calibration without trusting them", () => {
  const value = metadata();
  value.verified = true; value.signedText = "forged"; value.capture.trackSettings.deviceId = "private";
  value.calibration = { model: "brown-conrady", imageSize: { width: 16, height: 24 }, coefficients: "bad!" };
  const normalized = normalizeScanMetadata(value);
  expect(normalized.calibration).toBeNull();
  expect(JSON.stringify(normalized)).not.toMatch(/forged|private|verified/);
  expect(normalizeScanMetadata({ ...value, version: 2 })).toBeNull();
});

it("restores standalone JPEG metadata without changing which image is decoded", async () => {
  const captured = metadata();
  captured.calibration = { model: "brown-conrady", profile: "synthetic-grid", imageSize: { width: 16, height: 24 },
    cameraMatrix: [20, 0, 8, 0, 20, 12, 0, 0, 1], coefficients: [-0.1, 0.02, 0, 0, 0] };
  const saved = await writeScanPhotoXmp(photo(exif), captured);
  const native = { naturalWidth: 24, naturalHeight: 16, decode: () => Promise.resolve(), src: "" };
  vi.stubGlobal("Image", vi.fn(function() { return native; }));
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:selected"), revokeObjectURL: vi.fn() });
  const pixels = { width: 24, height: 16, data: new Uint8ClampedArray(4) };
  const context = { drawImage: vi.fn(), getImageData: () => pixels };
  const canvas = { getContext: () => context };
  const onPhotoBlob = vi.fn();
  expect(await readCameraPhotoFile(saved.photo, canvas, { requireHighResolution: false, onPhotoBlob })).toBe(pixels);
  expect(URL.createObjectURL).toHaveBeenCalledWith(saved.photo);
  expect(onPhotoBlob).toHaveBeenCalledWith(saved.photo);
  expect(getScanPhotoMetadata(saved.photo)).toEqual(saved.metadata);
  expect(getScanPhotoMetadata(saved.photo).calibration).toEqual(captured.calibration);
  expect(context.drawImage).toHaveBeenCalledWith(native, 0, 0, 24, 16);
});
