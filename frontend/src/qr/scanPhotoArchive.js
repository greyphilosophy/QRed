import { downloadZip } from "client-zip";
import { BlobReader, unzipRaw } from "unzipit";

const photoExtensions = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
  "image/avif": ".avif", "image/heic": ".heic", "image/heif": ".heif" };
const photoTypes = Object.fromEntries(Object.entries(photoExtensions).map(([type, ext]) => [ext, type]));
photoTypes[".jpeg"] = "image/jpeg";
const pendingDownloads = new WeakSet();

// Preserve the camera's original bytes and metadata inside the offline download.
export async function downloadCameraPhoto(photo, onError) {
  if (pendingDownloads.has(photo)) return;
  pendingDownloads.add(photo);
  try {
    const name = `exposure-01${photoExtensions[photo.type] || ".bin"}`;
    const archive = await downloadZip([{ name, input: photo }]).blob();
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
  const files = entries.filter(entry => !entry.isDirectory && !entry.name.split("/").some(part => part.startsWith(".") || part === "__MACOSX"));
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
  return photo;
}
