import { useEffect, useImperativeHandle, useRef, useState } from "react";
import { pdfScanSummary, scanPdfSeals } from "./scanPdf.js";
import "./pdfSealInput.css";

export function PdfSealInput({ onSeal, session = 0, controlsRef, onActivity, onStateChange, hideStatus = false }) {
  const active = useRef(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  useEffect(() => { onStateChange?.({ busy, status }); }, [busy, status, onStateChange]);
  useEffect(() => {
    active.current?.abort();
    active.current = null;
    setBusy(false);
    setStatus("");
    return () => active.current?.abort();
  }, [session]);

  useImperativeHandle(controlsRef, () => ({ openFile, stop: stopReading }));

  async function openFile(file) {
    if (!file) return;
    onActivity?.();
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setStatus("Opening PDF on this device…");
    async function submitPage(seal, image, options) {
      controller.signal.throwIfAborted();
      const context = { replaceImage: true, session, ...options };
      if (!image) return onSeal(seal, null, context);
      const canvas = document.createElement("canvas");
      canvas.width = image.width; canvas.height = image.height;
      try {
        canvas.getContext("2d").putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
        await onSeal(seal, canvas, context);
      } finally { canvas.width = canvas.height = 0; }
    }
    try {
      const result = await scanPdfSeals(file, {
        signal: controller.signal,
        onProgress: ({ pageNumber, pageCount }) => {
          if (!controller.signal.aborted) setStatus(`Reading seals on PDF page ${pageNumber} of ${pageCount}…`);
        },
        onSeal: submitPage,
        onOriginalPage: (seal, image, options) => submitPage(seal, image, { ...options, originalPage: true }),
      });
      if (!controller.signal.aborted) setStatus(pdfScanSummary(result));
    } catch (error) {
      if (!controller.signal.aborted) setStatus(`Could not read PDF seals: ${error.message}`);
    } finally {
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  }

  function openPdf(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    return openFile(file);
  }

  function stopReading() {
    active.current?.abort(); active.current = null; setBusy(false);
    setStatus("PDF reading stopped. Seals already found remain collected.");
  }

  return <div className="pdf-seal-input">
    <label htmlFor="verify-pdf">Open PDF to verify</label>
    <input id="verify-pdf" type="file" accept=".pdf,application/pdf" onChange={openPdf} />
    <p>Reads QR seals from every page on this device. Compare the page with its signed contents below; a valid seal alone does not prove that the surrounding page is unchanged.</p>
    {!hideStatus && busy && <button className="btn btn-secondary" type="button" onClick={stopReading}>Stop reading PDF</button>}
    {!hideStatus && status && <p role="status" aria-live="polite">{status}</p>}
  </div>;
}
