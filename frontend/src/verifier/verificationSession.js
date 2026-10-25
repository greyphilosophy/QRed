import { decodeSeal, verifyQRedSeals } from "../qredVerifier.js";
import { verifySealCollection, sealCollectionProgress } from "../sealCollection.js";

// Both verifier screens use this collection and async lifetime. UI state,
// camera frames and key lookup policy remain with their callers.
export function createVerificationSession() {
  let revision = 0;
  let snapshot = { seals: [], results: [], busy: false, session: 0, progress: null };
  const listeners = new Set();

  function publish(changes) {
    snapshot = { ...snapshot, ...changes };
    snapshot.progress = sealCollectionProgress(snapshot.seals, snapshot.results);
    listeners.forEach(listener => listener());
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    add(seals) {
      const next = [...new Set([...snapshot.seals, ...[seals].flat().filter(seal => decodeSeal(seal))])];
      if (next.length === snapshot.seals.length) return false;
      revision += 1;
      publish({ seals: next, results: [], busy: false });
      return true;
    },
    async verify(publicKey, verify = verifyQRedSeals) {
      const request = ++revision;
      const seals = snapshot.seals;
      publish({ busy: seals.length > 0, results: [] });
      const ordered = await verifySealCollection(seals, publicKey, verify);
      if (request !== revision) return;
      publish({ results: ordered, busy: false });
      return ordered;
    },
    cancel() { revision += 1; },
    clear() {
      revision += 1;
      publish({ seals: [], results: [], busy: false, session: snapshot.session + 1 });
    },
  };
}
