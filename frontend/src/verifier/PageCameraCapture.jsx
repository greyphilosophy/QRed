/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import { startCameraSession } from "../qr/cameraSession.js";
import { getPreferredCameraStream, applyCameraQualityControls } from "../qr/cameraControls.js";
import { snapshotScanPhoto } from "./scanPhotos.js";
import { scanPhotoInWorker } from "../qr/photoScanClient.js";
import { decodeSeal } from "../qredVerifier.js";
import { bytesEqual, qrPayloadBytes } from "../sealFormat.js";

// Match bytes from the already authenticated collection, not an untrusted page
// number or chunk identifier supplied by the new photo.
export function confirmsPageSeal(action, seals) {
  const scanned = (action.texts || [action.text]).filter(text => decodeSeal(text));
  return scanned.length > 0 && scanned.every(text => seals.some(seal =>
    bytesEqual(qrPayloadBytes(text), qrPayloadBytes(seal))));
}

// Retakes stay in the browser camera. No file-capture handoff or gallery save.
export function PageCameraCapture({ pageLabel, seals = [], onCapture, onClose }) {
  const video = useRef(null), camera = useRef(null), generation = useRef(0);
  const scan = useRef(null);
  const dialog = useRef(null);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    camera.current = startCameraSession({ video: video.current, requestStream: getPreferredCameraStream,
      prepareStream: applyCameraQualityControls,
      onFrame: () => { if (video.current?.videoWidth) setReady(true); },
      onError: cause => setError(`Camera could not open. ${cause.message}`) });
    return () => { generation.current++; scan.current?.abort(); camera.current?.stop(); previous?.focus?.(); };
  }, []);
  async function capture() {
    const epoch = generation.current, source = video.current;
    if (!source?.videoWidth || busy) return;
    setBusy(true); setError("");
    scan.current = new AbortController();
    const canvas = document.createElement("canvas");
    canvas.width = source.videoWidth; canvas.height = source.videoHeight;
    try {
      const context = canvas.getContext("2d");
      context.drawImage(source, 0, 0);
      const action = await scanPhotoInWorker(context.getImageData(0, 0, canvas.width, canvas.height),
        { returnPayload: true, signal: scan.current.signal });
      if (epoch !== generation.current) return;
      if (!confirmsPageSeal(action, seals)) {
        throw new Error(action.text || action.texts?.length
          ? `This seal does not match ${pageLabel}. Show that page, including its seal. Your previous check is unchanged.`
          : `The page seal could not be read. Include the whole page and its seal, then try again. Your previous check is unchanged.`);
      }
      const file = await snapshotScanPhoto(canvas);
      if (epoch !== generation.current) return;
      camera.current.stop();
      onCapture(file); onClose();
    } catch (cause) { if (epoch === generation.current) { setError(cause.message); setBusy(false); } }
    finally { canvas.width = canvas.height = 0; }
  }
  return <div className="page-camera-backdrop"><section className="page-camera" role="dialog" aria-modal="true"
    aria-label={`Retake ${pageLabel}`} tabIndex={-1} ref={dialog} onKeyDown={event => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const buttons = [...dialog.current.querySelectorAll("button:not(:disabled)")];
        if (event.shiftKey && (document.activeElement === buttons[0] || document.activeElement === dialog.current)) {
          event.preventDefault(); buttons.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
      }
    }}>
    <h3>Retake {pageLabel}</h3><p>Include all four page corners and the seal. Keep the text upright and avoid glare.</p>
    <video ref={video} playsInline autoPlay muted />
    {busy && <p role="status">Checking the page seal…</p>}
    {error && <p role="alert">{error}</p>}
    <div className="photo-actions"><button type="button" disabled={!ready || busy} onClick={capture}>Use this view</button>
      <button type="button" onClick={onClose}>Cancel retake</button></div>
    <p className="photo-note">This image is used temporarily in QRed. It is not saved to your photo library.</p>
  </section></div>;
}
