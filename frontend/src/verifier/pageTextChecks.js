import { createPhotoOcrReader, openPagePhoto } from "./photoOcr.js";
import { comparePageReading } from "./photoReading.js";

// One OCR worker, one page at a time. All document data belongs to this session;
// nothing here uses a network, download, or persistent-storage API.
export function createPageTextChecks({ reader = createPhotoOcrReader(), open = openPagePhoto,
  createUrl = file => URL.createObjectURL(file), revokeUrl = url => URL.revokeObjectURL(url) } = {}) {
  const listeners = new Set(), records = new Map();
  let ready = false, error = "", job = null, paused = false, disposed = false;
  let snapshot = { pages: [], ready, preparing: false, error };
  function publish() {
    snapshot = { pages: [...records.values()], ready, preparing: job?.kind === "prepare", error };
    listeners.forEach(listener => listener());
  }
  function release(record) {
    if (record.url) revokeUrl(record.url);
    record.url = null; record.comparison = null; record.file = null; record.page = null; record.reference = "";
  }
  function cancelJob() {
    if (job?.canvas) job.canvas.width = job.canvas.height = 0;
    job = null; ready = false; reader.dispose();
  }
  async function prepare() {
    if (disposed) throw new Error("This check has ended.");
    if (ready) return;
    if (job?.kind === "prepare") return job.promise;
    const current = { kind: "prepare" };
    job = current; error = "";
    current.promise = Promise.resolve().then(() => reader.prepare()).then(() => {
      if (job !== current || disposed) throw new Error("This check has ended.");
      ready = true;
    }).catch(cause => {
      if (job === current) error = `Text recognition could not load. ${cause.message}`;
      throw cause;
    }).finally(() => {
      if (job === current) { job = null; publish(); pump(); }
    });
    publish();
    return current.promise;
  }
  function pump() {
    if (disposed || paused || job || error) return;
    const record = [...records.values()].find(item => item.state === "queued");
    if (!record) return;
    if (!ready) { prepare().catch(() => {}); return; }
    const current = { kind: "read", record };
    job = current; record.state = "reading"; record.progress = null; publish();
    const valid = () => job === current && records.get(record.id) === record && !disposed;
    (async () => {
      let canvas;
      try {
        canvas = await open(record.file);
        if (!valid()) return;
        current.canvas = canvas;
        const words = await reader.read(canvas, event => {
          if (!valid()) return;
          const progress = event.status === "recognizing text" && Number.isFinite(event.progress)
            && event.progress >= 0 && event.progress < 1 ? event.progress : null;
          if (record.progress === progress) return;
          record.progress = progress; publish();
        }, { text: record.page.content, evidence: record.page.evidence, file: record.file, pageNumber: record.page.page_number });
        if (!valid()) return;
        record.comparison = comparePageReading(record.page.content, words, canvas, record.page.evidence, { pageNumber: record.page.page_number });
        record.width = canvas.width; record.height = canvas.height;
        record.url = createUrl(record.file);
        record.state = record.comparison.status;
        record.progress = null;
      } catch (cause) {
        if (valid()) { record.state = "error"; record.error = `Could not read this page. ${cause.message}`; }
      } finally {
        if (canvas) canvas.width = canvas.height = 0;
        if (valid()) { job = null; publish(); pump(); }
      }
    })();
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    prepare,
    update(results, photos, { scanning = false, verifying = false } = {}) {
      if (disposed) return;
      paused = scanning || verifying;
      // Verification temporarily removes results while reconstructing seals.
      // Do not discard a completed comparison until the new verdict is known.
      if (verifying) return;
      const keep = new Set();
      for (const page of results) {
        if (page.status !== "VALID" || page.signature_valid !== true || !page.content?.trim()) continue;
        const id = page.document_id;
        keep.add(id);
        const capture = photos.find(photo => photo.documentId === id);
        const reference = `${page.key_id}:${page.page_hash}:${page.content}`;
        const old = records.get(id);
        if (old && old.reference === reference && old.captureId === capture?.id) continue;
        if (job?.record === old && old) cancelJob();
        if (old) release(old);
        records.set(id, { id, page, reference, captureId: capture?.id, file: capture?.file,
          state: capture ? "queued" : "missing", comparison: null, url: null });
      }
      for (const [id, record] of records) if (!keep.has(id)) {
        if (job?.record === record) cancelJob();
        release(record); records.delete(id);
      }
      publish(); pump();
    },
    retry(id) {
      const record = records.get(id);
      if (record?.file && job?.record !== record) {
        if (record.url) revokeUrl(record.url);
        record.url = null; record.comparison = null; record.error = ""; record.state = "queued";
      }
      error = ""; publish(); pump();
    },
    clear() {
      cancelJob();
      records.forEach(release); records.clear(); error = ""; publish();
    },
    dispose() { this.clear(); disposed = true; listeners.clear(); },
  };
}
