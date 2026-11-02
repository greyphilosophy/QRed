/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import { startCameraSession } from "../qr/cameraSession.js";
import { getPreferredCameraStream, applyCameraQualityControls } from "../qr/cameraControls.js";
import { snapshotScanPhoto } from "./scanPhotos.js";

// Retakes stay in the browser camera. No file-capture handoff or gallery save.
export function PageCameraCapture({ pageLabel, onCapture, onClose }) {
  const video = useRef(null), camera = useRef(null), generation = useRef(0);
  const dialog = useRef(null);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    camera.current = startCameraSession({ video: video.current, requestStream: getPreferredCameraStream,
      prepareStream: applyCameraQualityControls,
      onFrame: () => { if (video.current?.videoWidth) setReady(true); },
      onError: cause => setError(`Camera could not open. ${cause.message}`) });
    return () => { generation.current++; camera.current?.stop(); previous?.focus?.(); };
  }, []);
  async function capture() {
    const epoch = generation.current, source = video.current;
    if (!source?.videoWidth || busy) return;
    setBusy(true);
    const canvas = document.createElement("canvas");
    canvas.width = source.videoWidth; canvas.height = source.videoHeight;
    try {
      canvas.getContext("2d").drawImage(source, 0, 0);
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
    <h3>Retake {pageLabel}</h3><p>Include all four page corners. Keep the text upright and avoid glare.</p>
    <video ref={video} playsInline autoPlay muted />
    {error && <p role="alert">{error}</p>}
    <div className="photo-actions"><button type="button" disabled={!ready || busy} onClick={capture}>Use this view</button>
      <button type="button" onClick={onClose}>Cancel retake</button></div>
    <p className="photo-note">This image is used temporarily in QRed. It is not saved to your photo library.</p>
  </section></div>;
}
