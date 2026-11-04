import { decodePhoto } from "./decodePhoto.js";
import { decodeSeal } from "../qredVerifier.js";
import { erasureDiscoveryImage, validatePhotoImage } from "./photoScanImage.js";
import { scanErasureSeals } from "./scanErasureSeals.js";

const MAX_PHOTO_DURATION_MS = 8000, MAX_ERASURE_DURATION_MS = 2000;
const noSeal = () => ({ status: "feedback", message: "No readable seal found. Include the whole page, hold steady, and avoid glare. Try another photo." });

function completeErasureGroups(texts) {
  const groups = new Map();
  for (const text of texts) {
    const record = decodeSeal(text);
    if (!record?.erasure) return false;
    // QRE document_id binds version, k, n, record length and the full digest.
    if (!groups.has(record.document_id)) groups.set(record.document_id, { required: record.required_chunks, indexes: new Set() });
    groups.get(record.document_id).indexes.add(record.chunk_number);
  }
  return groups.size > 0 && [...groups.values()].every(group => group.indexes.size >= group.required);
}

// Only captured photos use this asynchronous entry point. Live previews and
// the public synchronous decoder keep their existing API and behavior.
export async function decodePhotoWithErasure(image, { returnPayload = false, maxDurationMs = MAX_PHOTO_DURATION_MS, signal } = {}) {
  signal?.throwIfAborted();
  validatePhotoImage(image);
  if (!Number.isFinite(maxDurationMs)) throw new RangeError("Invalid photo scan time budget");
  const duration = Math.max(0, Math.min(MAX_PHOTO_DURATION_MS, maxDurationMs));
  const started = performance.now(), deadline = started + duration;
  const erasureDeadline = started + Math.min(MAX_ERASURE_DURATION_MS, duration / 4);
  const shouldContinue = () => { signal?.throwIfAborted(); return performance.now() < erasureDeadline; };
  let texts = [];
  if (returnPayload && shouldContinue()) {
    const discovery = erasureDiscoveryImage(image, { signal, shouldContinue });
    if (discovery && shouldContinue()) texts = await scanErasureSeals(discovery, { signal, shouldContinue });
    signal?.throwIfAborted();
    // This shortcut only collects observations. Every recovered shard,
    // including conflicting extras, still goes to the normal verifier.
    // Nothing here authenticates a signature or checks visible page text.
    if (completeErasureGroups(texts)) return { status: "found-multiple", texts };
  }
  signal?.throwIfAborted();
  const remaining = Math.max(0, deadline - performance.now());
  const action = remaining > 0 ? decodePhoto(image, { returnPayload, maxDurationMs: remaining }) : noSeal();
  signal?.throwIfAborted();
  if (!texts.length) return action;
  // Deduplicate identical observations, never distinct bytes for one index.
  // An unrelated legacy result must not erase incomplete QRE evidence.
  texts = [...new Set([...texts, ...(action.status === "found-multiple" ? action.texts : action.status === "found" ? [action.text] : [])])];
  return { status: "found-multiple", texts };
}
