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
  const pending = new Map(), aliases = new Map();
  const pageKey = key => aliases.get(key) || key;
  function discard(key, bundle = false) {
    for (const [id, capture] of pending) {
      if (pageKey(id) === pageKey(key) || bundle && capture.bundleId === key) pending.delete(id);
    }
    photos = photos.filter(photo => pageKey(photo.key) !== pageKey(key) && (!bundle || photo.bundleId !== key));
  }
  const publish = () => onChange({ photos, notice });
  return {
    bindResults(results) {
      for (const page of results) {
        if (page.status !== "VALID" || !page.record_id) continue;
        for (const id of [page.document_id, ...(page.photo_ids || [])]) aliases.set(id, page.record_id);
      }
    },
    async capture(seal, source, { replace = false, originalPage = false, documentId } = {}) {
      const decoded = decodeSeal(seal);
      if (!decoded) return;
      const key = originalPage && documentId ? documentId : decoded.document_id;
      if (decoded.seal_sheet && !originalPage) {
        if (replace) {
          discard(key, Boolean(decoded.document_bundle));
          publish();
        }
        return;
      }
      // Reopening a PDF must invalidate every photo alias of this signed
      // page, even if encoding its replacement subsequently fails.
      if (replace) { discard(key); publish(); }
      if (!source?.width || !source?.height) return;
      if (!replace && (pending.has(key) || photos.some(photo => photo.key === key))) return;
      if (!pending.has(key) && pending.size >= MAX_PENDING_PHOTOS) {
        notice = "Some scan images could not be kept. Retake any unchecked page below.";
        publish();
        return;
      }
      const epoch = generation, id = ++sequence;
      pending.set(key, { id, bundleId: decoded.document_bundle ? decoded.document_id : null });
      try {
        const file = await snapshot(source);
        if (epoch !== generation || pending.get(key)?.id !== id) return;
        if (!file?.size || file.size > MAX_SCAN_PHOTO_BYTES) throw new Error("Image too large.");
        photos = [...photos, { id, key, documentId: key, chunkNumber: decoded.chunk_number, file,
          ...(decoded.document_bundle ? { bundleId: decoded.document_id } : {}) }]
          .sort((a, b) => a.id - b.id);
        let bytes = photos.reduce((sum, photo) => sum + photo.file.size, 0);
        while (photos.length > MAX_SCAN_PHOTOS || bytes > MAX_SCAN_PHOTO_BYTES) {
          bytes -= photos[0].file.size;
          photos = photos.slice(1);
          notice = "Older scan images were released to save memory. Retake any unchecked page below.";
        }
        publish();
      } catch {
        if (epoch !== generation || pending.get(key)?.id !== id) return;
        notice = "A scan image could not be kept. The seal is still collected; retake this page below.";
        publish();
      } finally {
        if (pending.get(key)?.id === id) pending.delete(key);
      }
    },
    replacePage(documentId, file) {
      if (!file?.size || file.size > MAX_SCAN_PHOTO_BYTES) {
        notice = "This image is too large. Retake the page."; publish(); return;
      }
      discard(documentId);
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
      pending.clear(); aliases.clear(); photos = []; notice = "";
      publish();
    },
  };
}
