import { decodeSeal, verifyQRedSeals } from "./qredVerifier.js";

// Keep documents/iterations in first-seen order, with their recovered pages
// together in numeric order. Incomplete chunks have no page metadata yet.
export function orderSealResults(results) {
  const documents = new Map();
  for (const result of results) {
    const identity = result.pdf && Number.isInteger(result.page_number)
      && result.document_root && result.key_id && result.timestamp
      ? JSON.stringify([result.document_root, result.key_id, result.timestamp, result.page_count, result.identity])
      : result;
    if (!documents.has(identity)) documents.set(identity, []);
    documents.get(identity).push(result);
  }
  return [...documents.values()].flatMap(pages => [...pages].sort((a, b) => a.page_number - b.page_number));
}

// Conservative retained-output accounting: UTF-16 strings, typed-array bytes,
// and object/entry overhead. Stop traversal as soon as its budget is exhausted.
function outputSize(value, limit) {
  const pending = [value], seen = new Set(); let size = 0;
  while (pending.length && size <= limit) {
    const item = pending.pop();
    if (typeof item === "string") { size += item.length * 2; continue; }
    if (!item || typeof item !== "object") { size += 8; continue; }
    if (seen.has(item)) continue;
    seen.add(item);
    if (ArrayBuffer.isView(item)) { size += item.byteLength; continue; }
    const values = Object.values(item); size += 64 + values.length * 16;
    for (const child of values) pending.push(child);
  }
  return size;
}
export async function verifySealCollection(seals, publicKey, verify = verifyQRedSeals, { shouldContinue = () => true } = {}) {
  if (!Array.isArray(seals) || seals.length > 4096 || seals.some(seal => typeof seal !== "string" || seal.length > 8192) ||
      seals.reduce((sum, seal) => sum + seal.length, 0) > 24 * 1024 * 1024) {
    return [{ status: "ERROR", error_message: "Seal collection exceeds the input limit" }];
  }
  const groups = new Map();
  for (const seal of seals) {
    const id = decodeSeal(seal)?.document_id || "";
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(seal);
  }
  const entries = [...groups], results = [];
  let remaining = 64 * 1024 * 1024;
  // Both transient verification work and retained decoded evidence are bounded.
  for (let start = 0; start < entries.length; start += 4) {
    if (!shouldContinue()) return [];
    const batch = await Promise.all(entries.slice(start, start + 4).map(async ([id, group]) => {
      try {
        const result = await verify(group, publicKey);
        return { ...result, document_id: result.document_id || id };
      } catch (error) {
        return { status: "ERROR", document_id: id, error_message: error.message || String(error) };
      }
    }));
    if (!shouldContinue()) return [];
    for (const result of batch) {
      remaining -= outputSize(result, remaining);
      if (remaining < 0) return [{ status: "ERROR", error_message: "Decoded seal collection exceeds the output limit" }];
      results.push(result);
    }
  }
  return orderSealResults(results);
}

// A chunk identifies its page record, not its PDF. Page membership becomes
// available after reconstruction. Never combine different signing iterations.
export function sealCollectionProgress(seals, results = []) {
  const activeSeal = seals.at(-1);
  const active = decodeSeal(activeSeal);
  if (!active) return null;
  const chunks = new Set(seals.map(decodeSeal)
    .filter(item => item?.document_id === active.document_id).map(item => item.chunk_number));
  const result = results.find(item => item.document_id === active.document_id)
    || results.find(item => item.status === "ERROR" && !item.document_id);
  const progress = { activeSeal, collected: chunks.size, total: active.required_chunks || active.total_chunks,
    complete: false, finished: false };
  if (result?.status === "INVALID" || result?.status === "ERROR") {
    return { ...progress, finished: true, message: "Seal verification failed. Review the result below." };
  }
  if (chunks.size < (active.required_chunks || active.total_chunks)) {
    return { ...progress, message: `${chunks.size} of ${active.required_chunks || active.total_chunks} ${active.erasure ? "required " : ""}QR seals collected for this page. Keep scanning.` };
  }
  if (!result || result.status === "INCOMPLETE") {
    return { ...progress, message: "Checking collected seals…" };
  }
  const unverified = result.status !== "VALID";
  if (result.pdf && result.page_count > 1) {
    const members = results.filter(item => (item.status === "VALID" || item.status === "UNVERIFIED")
      && item.pdf && item.document_root === result.document_root && item.key_id === result.key_id
      && item.timestamp === result.timestamp && item.page_count === result.page_count
      && JSON.stringify(item.identity) === JSON.stringify(result.identity));
    const pages = new Set(members.map(item => item.page_number));
    const complete = pages.size === result.page_count;
    let nextPage = 1;
    while (pages.has(nextPage)) nextPage++;
    const message = complete ? `All ${result.page_count} pages collected.`
      : `Page ${result.page_number} captured. Show page ${nextPage}. ${pages.size} of ${result.page_count} pages collected.`;
    return { ...progress, pagesCollected: pages.size, pagesTotal: result.page_count,
      complete, finished: complete,
      message: message + (members.some(item => !item.metadata_authenticated) ? " Page counts are unverified." : "") };
  }
  return { ...progress, complete: true, finished: true,
    message: (active.erasure ? "Enough QR seals recovered." : "All QR seals collected.") + (unverified ? " Signature not verified." : "") };
}
