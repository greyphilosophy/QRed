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
import { captureCameraPhoto, readCameraPhotoFile, cameraPhotoFailure, cameraFrameDiagnostic, cameraCaptureFeedback } from "../qr/cameraPhoto.js";

// Match bytes from the already authenticated collection, not an untrusted page
// number or chunk identifier supplied by the new photo.
export function confirmsPageSeal(action, seals) {
  const scanned = (action.texts || [action.text]).filter(text => decodeSeal(text));
  return scanned.length > 0 && scanned.every(text => seals.some(seal =>
    bytesEqual(qrPayloadBytes(text), qrPayloadBytes(seal))));
}

// Native stills and explicitly selected photos stay in this browser session.
export function PageCameraCapture({ pageLabel, seals = [], onCapture, onClose }) {
  const video = useRef(null), camera = useRef(null), generation = useRef(0);
  const scan = useRef(null), captureDiagnostic = useRef(null), photoInput = useRef(null);
  const acquisitionFailed = useRef(false), manualFailure = useRef(false);
  const pickerSession = useRef(null), cameraAvailable = useRef(false), cameraFailed = useRef(false);
  const dialog = useRef(null);
  const guideArea = useRef(null), guide = useRef(null), live = useRef(null), busyRef = useRef(false);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [quality, setQuality] = useState(null);
  const [takingPhoto, setTakingPhoto] = useState(false);
  useEffect(() => {
    const previous = document.activeElement;
    cameraFailed.current = false;
    dialog.current?.focus();
    const canvas = document.createElement("canvas"), epoch = generation.current;
    const picker = photoInput.current;
    picker.addEventListener("cancel", resumePhotoPicker);
    const stopGuide = observePageScanGuide(video.current, guideArea.current, guide.current);
    live.current = createLiveScanWorker({ returnPayload: true, requirePageQuality: true,
      onQuality: value => { if (epoch === generation.current && !busyRef.current) setQuality(value); },
      onCaptured: ({ captureOnly } = {}) => {
        if (epoch !== generation.current || busyRef.current || manualFailure.current) return;
        if (captureOnly) { capture({ preserveGate: true }); return; }
        captureDiagnostic.current = cameraFrameDiagnostic(canvas);
        busyRef.current = true; setBusy(true); setError("");
      },
      onResult: action => {
        if (epoch !== generation.current || scan.current) return;
        action = cameraCaptureFeedback(action, captureDiagnostic.current);
        if (action.text || action.texts?.length) acceptFrame(action, canvas, epoch);
        else {
          if (action.status === "feedback" && !action.timedOut && !action.captureFailed) live.current.reset();
          busyRef.current = false; setBusy(false);
          if (action.message) setError(action.message);
        }
      }, onError: cause => { if (epoch !== generation.current) return; busyRef.current = false; setBusy(false); setError(cause.message); } });
    camera.current = startCameraSession({ video: video.current, requestStream: getPreferredCameraStream,
      prepareStream: applyCameraQualityControls,
      onFrame: () => {
        const source = video.current;
        if (epoch !== generation.current || !source?.videoWidth) return;
        cameraAvailable.current = true; setReady(true);
        if (busyRef.current || live.current.busy || manualFailure.current) return;
        if (canvas.width !== source.videoWidth) canvas.width = source.videoWidth;
        if (canvas.height !== source.videoHeight) canvas.height = source.videoHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(source, 0, 0);
        live.current.scan(context.getImageData(0, 0, canvas.width, canvas.height), { captureOnly: true });
      },
      onError: cause => { if (epoch === generation.current) { cameraAvailable.current = false; cameraFailed.current = true; setError(`Camera could not open. ${cause.message} Choose a high-resolution photo instead.`); } } });
    return () => {
      generation.current++; pickerSession.current = null; cameraAvailable.current = false;
      picker.removeEventListener("cancel", resumePhotoPicker);
      scan.current?.abort(); live.current?.stop(); camera.current?.stop();
      canvas.width = canvas.height = 0; stopGuide(); previous?.focus?.();
    };
  }, []);
  async function acceptFrame(action, canvas, epoch, controller) {
    const current = () => epoch === generation.current && (!controller || (scan.current === controller && !controller.signal.aborted));
    if (!current()) return;
    if (action.captureFailed) { setError(action.message); return; }
    busyRef.current = true; setBusy(true);
    try {
      if (!confirmsPageSeal(action, seals)) {
        throw new Error(action.text || action.texts?.length
          ? `This seal does not match ${pageLabel}. Show that page, including its seal. Your previous check is unchanged.`
          : action.message || `The page seal could not be read. Include the whole page and its seal, then try again. Your previous check is unchanged.`);
      }
      const file = await snapshotScanPhoto(canvas);
      if (!current()) return;
      cameraAvailable.current = false; pickerSession.current = null;
      camera.current?.stop(); live.current.stop();
      onCapture(file); onClose();
      if (typeof navigator.vibrate === "function") navigator.vibrate(80);
    } catch (cause) {
      if (current()) { if (!action.timedOut && !action.captureFailed) live.current.reset(); setError(cause.message); }
    }
    finally { if (current()) { busyRef.current = false; setBusy(false); } }
  }
  function cancelAttempt() {
    pickerSession.current = null;
    scan.current?.abort(); scan.current = null;
    manualFailure.current = true;
    busyRef.current = false; setBusy(false); setTakingPhoto(false);
  }
  function resumePhotoPicker() {
    const pending = pickerSession.current;
    pickerSession.current = null;
    // Dismissal resumes only the live camera that opened this picker. A late
    // cancel event must not reset a replacement file, closed dialog or error.
    if (!pending || pending.epoch !== generation.current || pending.camera !== camera.current
      || pending.live !== live.current || cameraFailed.current || scan.current || busyRef.current) return;
    manualFailure.current = false;
    // Permission/startup may still be pending. Release only the picker pause;
    // the already-started session will supply its first quality frame later.
    if (!cameraAvailable.current) return;
    acquisitionFailed.current = false;
    captureDiagnostic.current = null;
    live.current.reset();
    setError("");
    setQuality({ state: "framing", progress: 0, message: "Show all four page corners and hold steady for automatic capture." });
  }
  function choosePhoto() {
    cancelAttempt();
    pickerSession.current = { epoch: generation.current, camera: camera.current, live: live.current };
    photoInput.current.click();
  }
  function close() {
    generation.current++; cameraAvailable.current = false;
    cancelAttempt(); live.current?.stop(); camera.current?.stop();
    onClose();
  }
  async function capture({ preserveGate = false, file } = {}) {
    const epoch = generation.current, source = video.current;
    if (!file && (!source?.videoWidth || busyRef.current)) return;
    cancelAttempt();
    busyRef.current = true; setBusy(true); setError("");
    acquisitionFailed.current = false; manualFailure.current = false;
    if (!preserveGate) live.current.reset();
    const controller = new AbortController(); scan.current = controller;
    const current = () => epoch === generation.current && scan.current === controller && !controller.signal.aborted;
    const canvas = document.createElement("canvas");
    captureDiagnostic.current = null;
    setTakingPhoto(!file);
    try {
      const options = { signal: controller.signal, requireHighResolution: true, onDiagnostic: diagnostic => {
        if (current()) captureDiagnostic.current = diagnostic;
      } };
      const still = file ? await readCameraPhotoFile(file, canvas, options)
        : await captureCameraPhoto(source, canvas, options);
      if (!current()) return;
      setTakingPhoto(false);
      if (!still) {
        acquisitionFailed.current = true;
        // Automatic shots keep their page-movement gate. A manual failure must
        // not immediately become an automatic retry from a freshly reset gate.
        manualFailure.current = !preserveGate;
        setError(cameraPhotoFailure(captureDiagnostic.current).message);
        return;
      }
      const action = await scanPhotoInWorker(still, { returnPayload: true, signal: controller.signal });
      if (!current()) return;
      await acceptFrame(cameraCaptureFeedback(action, captureDiagnostic.current), canvas, epoch, controller);
    } catch (cause) { if (current() && cause.name !== "AbortError") setError(cause.message); }
    finally {
      canvas.width = canvas.height = 0;
      if (current()) { scan.current = null; busyRef.current = false; setBusy(false); setTakingPhoto(false); }
    }
  }
  return <div className="page-camera-backdrop"><section className="page-camera" role="dialog" aria-modal="true"
    aria-label={`Retake ${pageLabel}`} tabIndex={-1} ref={dialog} onKeyDown={event => {
      if (event.key === "Escape") close();
      if (event.key === "Tab") {
        const buttons = [...dialog.current.querySelectorAll("button:not(:disabled)")];
        if (event.shiftKey && (document.activeElement === buttons[0] || document.activeElement === dialog.current)) {
          event.preventDefault(); buttons.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
      }
    }}>
    <h3>Retake {pageLabel}</h3><p>Include all four page corners and hold steady for automatic capture. You can also use Capture now or choose a high-resolution photo.</p>
    <div style={{ position: "relative" }}><video ref={video} playsInline autoPlay muted />
      <div className="page-scan-guide-area" ref={guideArea} aria-hidden="true"><div className="page-scan-guide" ref={guide} hidden>
        <span /><span /><span /><span />
      </div></div></div>
    {!busy && !acquisitionFailed.current && quality && <p role="status">{quality.message}</p>}
    {!busy && !acquisitionFailed.current && quality?.state === "hold" && <progress className="capture-readiness" max="1" value={quality.progress} aria-label="Steady hold before automatic capture" />}
    {busy && <p role="status">{takingPhoto ? "Hold steady — taking photo…" : photoProcessingMessage()}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="photo-actions"><button type="button" disabled={!ready || busy} onClick={capture}>Capture now</button>
      <button type="button" onClick={choosePhoto}>Choose photo</button>
      <input ref={photoInput} type="file" accept="image/*" aria-label="Choose a high-resolution page photo" hidden onChange={event => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (file) capture({ file });
        else resumePhotoPicker();
      }} />
      <button type="button" onClick={close}>Cancel retake</button></div>
    <p className="photo-note">This image is used temporarily in QRed. It is not saved to your photo library.</p>
  </section></div>;
}
