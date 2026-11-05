import workerUrl from "./photoScan.worker.js?worker&url";
import { PHOTO_SCAN_BUDGET_MS, photoScanTimeoutAction } from "./photoScanBudget.js";
import { scanStageDiagnostic } from "./photoScanDiagnostics.js";

// Warm only public application code while the page is online. Wait for the
// service worker to control this tab so later scans/cancellations work offline.
let preparation;
export function preparePhotoScanner() {
  if (!navigator.serviceWorker) return Promise.resolve();
  return preparation ??= (async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => {
      const controlled = () => {
        if (!navigator.serviceWorker.controller) return;
        navigator.serviceWorker.removeEventListener("controllerchange", controlled);
        resolve();
      };
      navigator.serviceWorker.addEventListener("controllerchange", controlled);
      controlled();
    });
    const response = await fetch(workerUrl);
    if (!response.ok) throw new Error("Photo scanner could not be prepared for offline use.");
    await response.arrayBuffer();
  })().catch(() => { preparation = undefined; });
}

function runPhotoWorker(image, { signal, onStage, ...request }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Scan cancelled", "AbortError")); return; }
    const worker = new Worker(workerUrl, { type: "module" });
    let finished = false, timeout, partial = null, stage = null;
    const finish = (error, action) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      if (error) reject(error); else resolve(action);
    };
    const abort = () => finish(new DOMException("Scan cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (finished) return;
      if (data.scanStage) {
        const next = scanStageDiagnostic(data.scanStage);
        if (next) {
          stage = next;
          try { onStage?.(next); } catch (error) { finish(error); }
        }
        return;
      }
      if (data.progress) { partial = data.progress; return; }
      finish(data.error ? new Error(data.error) : null, data.action);
    };
    worker.onerror = event => {
      event.preventDefault();
      finish(new Error("The photo scan could not finish. Reopen QRed and try again."));
    };
    worker.onmessageerror = () => finish(new Error("The photo scan result could not be read. Try again."));
    // This timer runs outside the synchronous decoder. An in-worker timer or
    // Promise.race cannot interrupt jsQR while it is still using the CPU.
    // OCR pixel preparation is a separate operation with its own caller.
    if (!request.prepareReading) timeout = setTimeout(() =>
      finish(null, photoScanTimeoutAction(partial, stage)), PHOTO_SCAN_BUDGET_MS);
    try {
      // Transfer ownership instead of cloning a 12–48 MP pixel buffer.
      worker.postMessage({ image: { data: image.data, width: image.width, height: image.height }, ...request },
        [image.data.buffer]);
    } catch (error) { finish(error); }
  });
}

export function scanPhotoInWorker(image, { signal, onStage, returnPayload = false } = {}) {
  return runPhotoWorker(image, { signal, onStage, returnPayload });
}

export function preparePhotoReadingInWorker(image, { signal } = {}) {
  return runPhotoWorker(image, { signal, prepareReading: true });
}

// No frame queue: callers keep the submitted canvas unchanged until onResult
// runs, and check busy before drawing the next camera frame into that canvas.
export function createLiveScanWorker({ onResult, onError, returnPayload = false, requirePageQuality = false, onQuality, onCaptured, onStage }) {
  let worker = null, busy = false, stopped = false, paused = false;
  let timeout, partial = null, stage = null;
  const clearDeadline = () => { clearTimeout(timeout); timeout = undefined; partial = null; stage = null; };
  function reset() {
    clearDeadline();
    paused = false;
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      worker = null;
    }
    busy = false;
  }
  function stop() { stopped = true; reset(); }
  function fail(current, error) {
    if (worker !== current || stopped) return;
    stop();
    onError(error);
  }
  return {
    get busy() { return busy; },
    reset,
    stop,
    scan(image, { captureOnly = false } = {}) {
      if (stopped || paused || busy) return false;
      try {
        if (!worker) {
          const current = new Worker(workerUrl, { type: "module" });
          worker = current;
          current.onmessage = ({ data }) => {
            if (worker !== current || stopped || !busy) return;
            if (data.error) { fail(current, new Error(data.error)); return; }
            if (data.scanStage) {
              const next = scanStageDiagnostic(data.scanStage);
              if (next) {
                stage = next;
                try { onStage?.(next); } catch (error) { fail(current, error); }
              }
              return;
            }
            if (data.progress) { partial = data.progress; return; }
            if (data.captured) {
              // This is an intermediate acknowledgement, not a decoder result.
              // A native still handoff finishes this request; its caller freezes
              // capture while preserving this worker's page-movement gate.
              if (data.captureOnly) busy = false;
              else if (timeout === undefined) timeout = setTimeout(() => {
                if (worker !== current || stopped || !busy) return;
                const action = photoScanTimeoutAction(partial, stage);
                reset();
                // Termination also discards the page-movement gate. Do not
                // recapture unchanged paper forever; Capture now/reset resumes.
                paused = true;
                try { onResult(action); }
                catch (error) { stop(); onError(error); }
              }, PHOTO_SCAN_BUDGET_MS);
              try { if (data.quality) onQuality?.(data.quality); onCaptured?.({ captureOnly: !!data.captureOnly }); }
              catch (error) { fail(current, error); }
              return;
            }
            clearDeadline();
            busy = false;
            try { if (data.quality) onQuality?.(data.quality); onResult(data.action); }
            catch (error) { fail(current, error); }
          };
          current.onerror = event => {
            event.preventDefault();
            fail(current, new Error("Live scanning could not finish. Reopen the scanner and try again."));
          };
          current.onmessageerror = () => fail(current, new Error("The live scan result could not be read."));
        }
        busy = true;
        const qualityOptions = requirePageQuality ? { requirePageQuality, frameTime: performance.now(),
          ...(captureOnly ? { captureOnly: true } : {}) } : {};
        worker.postMessage({ image: { data: image.data, width: image.width, height: image.height }, returnPayload, live: true, ...qualityOptions },
          [image.data.buffer]);
        return true;
      } catch (error) {
        stop();
        onError(error);
        return false;
      }
    },
  };
}
