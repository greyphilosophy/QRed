import { decodeSeal, verifyQRedSeals } from "./qredVerifier.js";

export async function verifySealCollection(seals, publicKey) {
  const groups = new Map();
  for (const seal of seals) {
    const id = decodeSeal(seal)?.document_id || "";
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(seal);
  }
  return Promise.all([...groups].map(async ([id, group]) => {
    const result = await verifyQRedSeals(group, publicKey);
    return { ...result, document_id: result.document_id || id };
  }));
}

// A chunk identifies its page record, not its PDF. Page membership becomes
// available after reconstruction. Never combine different signing iterations.
export function sealCollectionProgress(seals, results = []) {
  const activeSeal = seals.at(-1);
  const active = decodeSeal(activeSeal);
  if (!active) return null;
  const chunks = new Set(seals.map(decodeSeal)
    .filter(item => item?.document_id === active.document_id).map(item => item.chunk_number));
  const result = results.find(item => item.document_id === active.document_id);
  const progress = { activeSeal, collected: chunks.size, total: active.total_chunks,
    complete: false, finished: false };
  if (result?.status === "INVALID" || result?.status === "ERROR") {
    return { ...progress, finished: true, message: "Seal verification failed. Review the result below." };
  }
  if (chunks.size < active.total_chunks) {
    return { ...progress, message: `${chunks.size} of ${active.total_chunks} QR seals collected for this page. Keep scanning.` };
  }
  if (!result || result.status === "INCOMPLETE") {
    return { ...progress, message: "Checking collected seals…" };
  }
  const unverified = result.status !== "VALID";
  if (result.pdf && result.page_count > 1) {
    const members = results.filter(item => (item.status === "VALID" || item.status === "UNVERIFIED")
      && item.pdf && item.document_root === result.document_root && item.key_id === result.key_id
      && item.timestamp === result.timestamp && item.page_count === result.page_count);
    const pages = new Set(members.map(item => item.page_number));
    const complete = pages.size === result.page_count;
    const message = complete ? `All ${result.page_count} pages collected.`
      : `${pages.size} of ${result.page_count} pages collected. Keep scanning.`;
    return { ...progress, pagesCollected: pages.size, pagesTotal: result.page_count,
      complete, finished: complete,
      message: message + (members.some(item => !item.metadata_authenticated) ? " Page counts are unverified." : "") };
  }
  return { ...progress, complete: true, finished: true,
    message: "All QR seals collected." + (unverified ? " Signature not verified." : "") };
}
