import { useEffect, useRef, useState } from "react";
import { pdfScanSummary, scanPdfSeals } from "./scanPdf.js";
import "./pdfSealInput.css";

export function PdfSealInput({ onSeal, session = 0 }) {
  const active = useRef(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  useEffect(() => {
    active.current?.abort();
    active.current = null;
    setBusy(false);
    setStatus("");
    return () => active.current?.abort();
  }, [session]);

  async function openPdf(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setStatus("Opening PDF on this device…");
    try {
      const result = await scanPdfSeals(file, {
        signal: controller.signal,
        onProgress: ({ pageNumber, pageCount }) => {
          if (!controller.signal.aborted) setStatus(`Reading seals on PDF page ${pageNumber} of ${pageCount}…`);
        },
        onSeal: async (seal, image) => {
          controller.signal.throwIfAborted();
          const canvas = document.createElement("canvas");
          canvas.width = image.width; canvas.height = image.height;
          try {
            canvas.getContext("2d").putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
            await onSeal(seal, canvas, { replaceImage: true });
          } finally { canvas.width = canvas.height = 0; }
        },
      });
      if (!controller.signal.aborted) setStatus(pdfScanSummary(result));
    } catch (error) {
      if (!controller.signal.aborted) setStatus(`Could not read PDF seals: ${error.message}`);
    } finally {
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  }

  return <div className="pdf-seal-input">
    <label htmlFor="verify-pdf">Open PDF to verify</label>
    <input id="verify-pdf" type="file" accept=".pdf,application/pdf" onChange={openPdf} />
    <p>Reads QR seals from every page on this device. Compare the page with its signed contents below; a valid seal alone does not prove that the surrounding page is unchanged.</p>
    {busy && <button className="btn btn-secondary" type="button" onClick={() => {
      active.current?.abort(); active.current = null; setBusy(false);
      setStatus("PDF reading stopped. Seals already found remain collected.");
    }}>Stop reading PDF</button>}
    {status && <p role="status" aria-live="polite">{status}</p>}
  </div>;
}
