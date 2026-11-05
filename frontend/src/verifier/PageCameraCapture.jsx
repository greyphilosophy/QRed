/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import { startCameraSession } from "../qr/cameraSession.js";
import { getPreferredCameraStream, applyCameraQualityControls } from "../qr/cameraControls.js";
import { snapshotScanPhoto } from "./scanPhotos.js";
import { createLiveScanWorker, scanPhotoInWorker } from "../qr/photoScanClient.js";
import { observePageScanGuide } from "../qr/pageScanGuide.js";
import { decodeSeal } from "../qredVerifier.js";
import { bytesEqual, qrPayloadBytes } from "../sealFormat.js";
import { photoProcessingMessage } from "./photoStatus.js";
import { canCaptureCameraPhoto, captureCameraPhoto, cameraFrameDiagnostic, cameraCaptureFeedback } from "../qr/cameraPhoto.js";

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
  const scan = useRef(null), captureDiagnostic = useRef(null);
  const dialog = useRef(null);
  const guideArea = useRef(null), guide = useRef(null), live = useRef(null), busyRef = useRef(false);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [quality, setQuality] = useState(null);
  const [takingPhoto, setTakingPhoto] = useState(false);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    const canvas = document.createElement("canvas"), epoch = generation.current;
    const stopGuide = observePageScanGuide(video.current, guideArea.current, guide.current);
    live.current = createLiveScanWorker({ returnPayload: true, requirePageQuality: true,
      onQuality: setQuality,
      onCaptured: ({ captureOnly } = {}) => {
        if (captureOnly) { capture({ preserveGate: true }); return; }
        captureDiagnostic.current = cameraFrameDiagnostic(canvas);
        busyRef.current = true; setBusy(true); setError("");
      },
      onResult: action => {
        action = cameraCaptureFeedback(action, captureDiagnostic.current);
        if (action.text || action.texts?.length) acceptFrame(action, canvas, epoch);
        else {
          if (action.status === "feedback" && !action.timedOut) live.current.reset();
          busyRef.current = false; setBusy(false);
          if (action.message) setError(action.message);
        }
      }, onError: cause => { busyRef.current = false; setBusy(false); setError(cause.message); } });
    camera.current = startCameraSession({ video: video.current, requestStream: getPreferredCameraStream,
      prepareStream: applyCameraQualityControls,
      onFrame: () => {
        const source = video.current;
        if (!source?.videoWidth) return;
        setReady(true);
        if (busyRef.current || live.current.busy) return;
        if (canvas.width !== source.videoWidth) canvas.width = source.videoWidth;
        if (canvas.height !== source.videoHeight) canvas.height = source.videoHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(source, 0, 0);
        live.current.scan(context.getImageData(0, 0, canvas.width, canvas.height), { captureOnly: canCaptureCameraPhoto(source) });
      },
      onError: cause => setError(`Camera could not open. ${cause.message}`) });
    return () => {
      generation.current++; scan.current?.abort(); live.current?.stop(); camera.current?.stop();
      canvas.width = canvas.height = 0; stopGuide(); previous?.focus?.();
    };
  }, []);
  async function acceptFrame(action, canvas, epoch) {
    busyRef.current = true; setBusy(true);
    try {
      if (!confirmsPageSeal(action, seals)) {
        throw new Error(action.text || action.texts?.length
          ? `This seal does not match ${pageLabel}. Show that page, including its seal. Your previous check is unchanged.`
          : action.message || `The page seal could not be read. Include the whole page and its seal, then try again. Your previous check is unchanged.`);
      }
      const file = await snapshotScanPhoto(canvas);
      if (epoch !== generation.current) return;
      camera.current.stop(); live.current.stop();
      onCapture(file); onClose();
      if (typeof navigator.vibrate === "function") navigator.vibrate(80);
    } catch (cause) {
      if (epoch === generation.current) { if (!action.timedOut) live.current.reset(); setError(cause.message); }
    }
    finally { if (epoch === generation.current) { busyRef.current = false; setBusy(false); } }
  }
  async function capture({ preserveGate = false } = {}) {
    const epoch = generation.current, source = video.current;
    if (!source?.videoWidth || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    if (!preserveGate) live.current.reset();
    scan.current = new AbortController();
    const controller = scan.current;
    const canvas = document.createElement("canvas");
    canvas.width = source.videoWidth; canvas.height = source.videoHeight;
    try {
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(source, 0, 0);
      const frame = context.getImageData(0, 0, canvas.width, canvas.height);
      const nativePhoto = canCaptureCameraPhoto(source);
      captureDiagnostic.current = cameraFrameDiagnostic(canvas);
      setTakingPhoto(nativePhoto);
      const still = nativePhoto ? await captureCameraPhoto(source, canvas, { signal: controller.signal, onDiagnostic: diagnostic => {
        if (epoch === generation.current && scan.current === controller) captureDiagnostic.current = diagnostic;
      } }) : null;
      controller.signal.throwIfAborted();
      setTakingPhoto(false);
      const action = await scanPhotoInWorker(still || frame,
        { returnPayload: true, signal: controller.signal });
      if (epoch !== generation.current) return;
      await acceptFrame(cameraCaptureFeedback(action, captureDiagnostic.current), canvas, epoch);
    } catch (cause) { if (epoch === generation.current) setError(cause.message); }
    finally {
      canvas.width = canvas.height = 0;
      if (epoch === generation.current) { busyRef.current = false; setBusy(false); setTakingPhoto(false); }
    }
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
    <h3>Retake {pageLabel}</h3><p>Include all four page corners and hold steady for automatic capture. You can also use Capture now.</p>
    <div style={{ position: "relative" }}><video ref={video} playsInline autoPlay muted />
      <div className="page-scan-guide-area" ref={guideArea} aria-hidden="true"><div className="page-scan-guide" ref={guide} hidden>
        <span /><span /><span /><span />
      </div></div></div>
    {!busy && quality && <p role="status">{quality.message}</p>}
    {!busy && quality?.state === "hold" && <progress className="capture-readiness" max="1" value={quality.progress} aria-label="Steady hold before automatic capture" />}
    {busy && <p role="status">{takingPhoto ? "Hold steady — taking photo…" : photoProcessingMessage()}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="photo-actions"><button type="button" disabled={!ready || busy} onClick={capture}>Capture now</button>
      <button type="button" onClick={onClose}>Cancel retake</button></div>
    <p className="photo-note">This image is used temporarily in QRed. It is not saved to your photo library.</p>
  </section></div>;
}
