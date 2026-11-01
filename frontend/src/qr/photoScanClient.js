import workerUrl from "./photoScan.worker.js?worker&url";

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

export function scanPhotoInWorker(image, { signal, returnPayload = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Scan cancelled", "AbortError")); return; }
    const worker = new Worker(workerUrl, { type: "module" });
    let finished = false;
    const finish = (error, action) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      if (error) reject(error); else resolve(action);
    };
    const abort = () => finish(new DOMException("Scan cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.action);
    worker.onerror = event => {
      event.preventDefault();
      finish(new Error("The photo scan could not finish. Reopen QRed and try again."));
    };
    worker.onmessageerror = () => finish(new Error("The photo scan result could not be read. Try again."));
    try {
      // Transfer ownership instead of cloning a 12–48 MP pixel buffer.
      worker.postMessage({ image: { data: image.data, width: image.width, height: image.height }, returnPayload },
        [image.data.buffer]);
    } catch (error) { finish(error); }
  });
}
