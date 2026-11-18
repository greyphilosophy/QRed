import { downloadZip } from "client-zip";
import { BlobReader, unzipRaw } from "unzipit";
import { getScanPhotoMetadata, MAX_SCAN_METADATA_BYTES, rememberScanMetadata } from "./scanPhotoMetadata.js";
import { writeScanPhotoXmp } from "./scanPhotoXmp.js";

const photoExtensions = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
  "image/avif": ".avif", "image/heic": ".heic", "image/heif": ".heif" };
const photoTypes = Object.fromEntries(Object.entries(photoExtensions).map(([type, ext]) => [ext, type]));
photoTypes[".jpeg"] = "image/jpeg";
const pendingDownloads = new WeakSet();
const METADATA_FILE = "qred-scan.json";

export async function createScanPhotoArchive(photo) {
  const name = `exposure-01${photoExtensions[photo.type] || ".bin"}`;
  const saved = await writeScanPhotoXmp(photo, getScanPhotoMetadata(photo));
  const files = [{ name, input: saved.photo }];
  if (saved.metadata) files.push({ name: METADATA_FILE, input: JSON.stringify({
    schema: "qred-scan-archive", version: 1,
    photos: [{ name, metadata: saved.metadata, embeddedXmp: saved.embedded }],
  }, null, 2) });
  return downloadZip(files).blob();
}

// Preserve image data and native metadata; add QRed XMP where supported and a
// JSON sidecar. Metadata enrichment never requires another exposure or network.
export async function downloadCameraPhoto(photo, onError) {
  if (pendingDownloads.has(photo)) return;
  pendingDownloads.add(photo);
  try {
    const archive = await createScanPhotoArchive(photo);
    const url = URL.createObjectURL(archive), link = document.createElement("a");
    try {
      link.href = url;
      link.download = "QRed-scan-photo.zip";
      document.body.appendChild(link);
      link.click();
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch (error) {
    if (!onError) throw error;
    onError("The scan ZIP could not be saved. Choose Save scan photo to try again.");
  } finally {
    pendingDownloads.delete(photo);
  }
}

export function isScanPhotoZip(file) {
  return /\.zip$/i.test(file.name || "") || ["application/zip", "application/x-zip", "application/x-zip-compressed"].includes(file.type);
}

// unzipit reads ZIP headers into memory but takes stored exposures directly
// from Blob slices. Bound metadata reads independently of the camera file size.
class ScanZipReader extends BlobReader {
  read(offset, length) {
    if (length > 1024 * 1024) throw new Error("Oversized scan ZIP directory");
    return super.read(offset, length);
  }
}

export async function readScanPhotoZip(file, signal) {
  signal?.throwIfAborted();
  let entries;
  try {
    ({ entries } = await unzipRaw(new ScanZipReader(file)));
  } catch {
    signal?.throwIfAborted();
    throw new Error("This ZIP could not be opened. Choose a scan ZIP saved by QRed.");
  }
  signal?.throwIfAborted();
  const visible = entries.filter(entry => !entry.isDirectory && !entry.name.split("/").some(part => part.startsWith(".") || part === "__MACOSX"));
  const metadataEntries = visible.filter(entry => entry.name.split("/").pop() === METADATA_FILE);
  const files = visible.filter(entry => entry.name.split("/").pop() !== METADATA_FILE);
  // Older saves can be a single named photo. Multiple files must identify
  // exposures of one capture, in shutter order even if the ZIP was repacked.
  const photos = files.map(entry => {
    const name = entry.name.split("/").pop();
    const number = /^exposure-(\d{2})\.[^.]+$/i.exec(name);
    const extension = /\.[^.]+$/.exec(name)?.[0].toLowerCase();
    const type = photoTypes[extension] || (number && extension === ".bin" ? "application/octet-stream" : null);
    return { entry, number: number ? Number(number[1]) : null, type };
  }).sort((a, b) => a.number - b.number);
  if (!photos.length || photos.length > 3 || photos.some(({ entry, number, type }, index) =>
    !type || !entry.size || ((number !== null || photos.length > 1) && number !== index + 1))) {
    throw new Error("Choose a ZIP with one photo or one numbered exposure stack saved by QRed.");
  }
  // Native scan ZIPs store the camera files directly. Bound the additional
  // storage needed to inflate a user-repacked archive before opening any entry.
  const inflatedBytes = photos.reduce((sum, { entry }) => sum + (entry.compressionMethod ? entry.size : 0), 0);
  if (inflatedBytes > 320_000_000) throw new Error("This compressed scan is too large. Choose an individual photo.");
  // Older captures kept up to three originals. Exposure 01 is the photo used for text comparison.
  const { entry, type } = photos[0];
  let photo;
  try {
    if (entry.compressionMethod === 0) photo = await entry.blob(type);
    else {
      const stream = await entry.stream();
      const body = signal ? stream.pipeThrough(new TransformStream(), { signal }) : stream;
      photo = await new Response(body, { headers: { "Content-Type": type } }).blob();
    }
  } catch {
    signal?.throwIfAborted();
    throw new Error("The photo in this ZIP could not be opened. Choose the original scan ZIP or an individual photo.");
  }
  signal?.throwIfAborted();
  // Optional metadata must never stop an otherwise readable old/new photo.
  // Match the exact sibling filename; never apply metadata for another exposure.
  const metadataEntry = metadataEntries.length === 1 ? metadataEntries[0] : null;
  if (metadataEntry && metadataEntry.name.slice(0, -METADATA_FILE.length) === entry.name.slice(0, entry.name.lastIndexOf("/") + 1)) {
    const archive = await readArchiveMetadata(metadataEntry, signal);
    if (archive?.schema === "qred-scan-archive" && archive.version === 1 && Array.isArray(archive.photos)) {
      const matching = archive.photos.filter(item => item?.name === entry.name.split("/").pop());
      if (matching.length === 1) rememberScanMetadata(photo, matching[0].metadata);
    }
  }
  signal?.throwIfAborted();
  return photo;
}

async function readArchiveMetadata(entry, signal) {
  if (!entry.size || entry.size > MAX_SCAN_METADATA_BYTES || entry.compressedSize > MAX_SCAN_METADATA_BYTES) return null;
  let reader;
  try {
    const stream = await entry.stream();
    reader = (signal ? stream.pipeThrough(new TransformStream(), { signal }) : stream).getReader();
    const chunks = []; let length = 0;
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_SCAN_METADATA_BYTES) return null;
      chunks.push(value);
    }
    return JSON.parse(await new Blob(chunks).text());
  } catch {
    signal?.throwIfAborted();
    return null;
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
