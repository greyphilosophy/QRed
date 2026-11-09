import { decodeSeal } from "../qredVerifier.js";

export const MAX_SCAN_PHOTOS = 16;
export const MAX_SCAN_PHOTO_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_PHOTOS = 4;

// Copy before yielding: the scanner reuses its canvas for the next frame.
// Keep the original colours, not the contrast-filtered watermark image.
export function snapshotScanPhoto(source) {
  const pixels = source?.width * source?.height;
  if (!pixels) return Promise.reject(new Error("No camera image available."));
  const scale = Math.min(1, Math.sqrt(6_000_000 / pixels));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("Cannot keep the camera image."));
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    // Release the temporary pixel buffer after encoding, including on failure.
    canvas.width = canvas.height = 0;
    if (blob) resolve(blob);
    else reject(new Error("Cannot keep the camera image."));
  }, "image/png"));
}

/** Session-only images, associated by signed page rather than scan order.
 * No OCR or trust decision happens here; only verified pages can use an image.
 */
export function createScanPhotoCollection(onChange, snapshot = snapshotScanPhoto) {
  let photos = [], notice = "", generation = 0, sequence = 0;
  const pending = new Map();
  const publish = () => onChange({ photos, notice });
  return {
    async capture(seal, source, { replace = false, originalPage = false } = {}) {
      const decoded = decodeSeal(seal);
      if (!decoded) return;
      const key = decoded.document_id; // One full-page capture per page, including multipart seals.
      if (decoded.seal_sheet && !originalPage) {
        if (replace) {
          pending.delete(key);
          photos = photos.filter(photo => photo.key !== key);
          publish();
        }
        return;
      }
      if (!source?.width || !source?.height) return;
      if (!replace && (pending.has(key) || photos.some(photo => photo.key === key))) return;
      if (!pending.has(key) && pending.size >= MAX_PENDING_PHOTOS) {
        notice = "Some scan images could not be kept. Retake any unchecked page below.";
        publish();
        return;
      }
      const epoch = generation, id = ++sequence;
      pending.set(key, id);
      if (replace) {
        // A newly opened PDF may reuse the same seal on a changed page. Never
        // leave its earlier scan image available as if it came from this file.
        photos = photos.filter(photo => photo.key !== key);
        publish();
      }
      try {
        const file = await snapshot(source);
        if (epoch !== generation || pending.get(key) !== id) return;
        if (!file?.size || file.size > MAX_SCAN_PHOTO_BYTES) throw new Error("Image too large.");
        photos = [...photos, { id, key, documentId: decoded.document_id, chunkNumber: decoded.chunk_number, file }]
          .sort((a, b) => a.id - b.id);
        let bytes = photos.reduce((sum, photo) => sum + photo.file.size, 0);
        while (photos.length > MAX_SCAN_PHOTOS || bytes > MAX_SCAN_PHOTO_BYTES) {
          bytes -= photos[0].file.size;
          photos = photos.slice(1);
          notice = "Older scan images were released to save memory. Retake any unchecked page below.";
        }
        publish();
      } catch {
        if (epoch !== generation || pending.get(key) !== id) return;
        notice = "A scan image could not be kept. The seal is still collected; retake this page below.";
        publish();
      } finally {
        if (pending.get(key) === id) pending.delete(key);
      }
    },
    replacePage(documentId, file) {
      if (!file?.size || file.size > MAX_SCAN_PHOTO_BYTES) {
        notice = "This image is too large. Retake the page."; publish(); return;
      }
      pending.delete(documentId);
      photos = photos.filter(photo => photo.documentId !== documentId);
      photos.push({ id: ++sequence, key: documentId, documentId, chunkNumber: 0, file });
      let bytes = photos.reduce((sum, photo) => sum + photo.file.size, 0);
      while (photos.length > MAX_SCAN_PHOTOS || bytes > MAX_SCAN_PHOTO_BYTES) {
        bytes -= photos[0].file.size; photos = photos.slice(1);
        notice = "Older scan images were released to save memory. Retake any unchecked page.";
      }
      publish();
    },
    clear() {
      generation += 1;
      pending.clear(); photos = []; notice = "";
      publish();
    },
  };
}
