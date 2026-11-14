/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import { startCameraSession } from "../qr/cameraSession.js";
import { snapshotScanPhoto } from "./scanPhotos.js";
import { createLiveScanWorker, scanPhotoInWorker } from "../qr/photoScanClient.js";
import { observePageScanGuide } from "../qr/pageScanGuide.js";
import { decodeSeal } from "../qredVerifier.js";
import { bytesEqual, qrPayloadBytes } from "../sealFormat.js";
import { CameraCaptureNotice, PhotoScanProgress, usePhotoScanProgress } from "../qr/PhotoScanProgress.jsx";
import { readCameraFrame, captureCameraPhoto, readCameraPhotoFile, cameraPhotoFailure, cameraFrameDiagnostic, cameraCaptureFeedback, cameraCaptureContext, downloadCameraPhoto } from "../qr/cameraPhoto.js";

// Match bytes from the already authenticated collection, not an untrusted page
// number or chunk identifier supplied by the new photo.
export function confirmsPageSeal(action, seals) {
  const scanned = (action.texts || [action.text]).filter(text => decodeSeal(text));
  return scanned.length > 0 && scanned.every(text => seals.some(seal =>
    bytesEqual(qrPayloadBytes(text), qrPayloadBytes(seal))));
}

// Camera capture, file selection and photo comparison all run locally.
export function PageCameraCapture({ pageLabel, seals = [], separateOriginal = false, onCapture, onClose }) {
  const title = separateOriginal ? `Photograph original ${pageLabel.toLowerCase()}` : `Retake ${pageLabel}`;
  const video = useRef(null), camera = useRef(null), generation = useRef(0);
  const lightButton = useRef(null);
  const scan = useRef(null), captureDiagnostic = useRef(null), photoInput = useRef(null);
  const lastQuality = useRef(null);
  const acquisitionFailed = useRef(false), autoPaused = useRef(false);
  const pickerSession = useRef(null), cameraAvailable = useRef(false), cameraFailed = useRef(false);
  const dialog = useRef(null);
  const guideArea = useRef(null), guide = useRef(null), live = useRef(null), busyRef = useRef(false);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [failedPhoto, setFailedPhoto] = useState(null);
  const [quality, setQuality] = useState(null);
  const progress = usePhotoScanProgress();
  const liveProgress = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    cameraFailed.current = false;
    dialog.current?.focus();
    const canvas = document.createElement("canvas"), epoch = generation.current;
    const picker = photoInput.current;
    picker.addEventListener("cancel", resumePhotoPicker);
    const stopGuide = observePageScanGuide(video.current, guideArea.current, guide.current);
    live.current = createLiveScanWorker({ returnPayload: true, requirePageQuality: true,
      onQuality: value => {
        if (epoch === generation.current && !busyRef.current) { lastQuality.current = { state: value.state }; setQuality(value); }
      },
      onCaptured: ({ captureOnly } = {}) => {
        if (epoch !== generation.current || busyRef.current || autoPaused.current) return;
        if (captureOnly) { capture({ preserveGate: true }); return; }
        liveProgress.current = progress.begin("captured");
        captureDiagnostic.current = cameraFrameDiagnostic(canvas);
        busyRef.current = true; setBusy(true); setError("");
      },
      onStage: stage => liveProgress.current?.stage(stage),
      onResult: action => {
        if (epoch !== generation.current || scan.current) return;
        const attempt = liveProgress.current;
        action = cameraCaptureFeedback(action, captureDiagnostic.current);
        if (action.text || action.texts?.length) {
          acceptFrame(action, canvas, epoch).finally(() => attempt?.stop());
        } else {
          attempt?.stop();
          if (action.status === "feedback" && !action.timedOut && !action.captureFailed) live.current.reset();
          busyRef.current = false; setBusy(false);
          if (action.message) setError(action.message);
        }
      }, onError: cause => { if (epoch !== generation.current) return; liveProgress.current?.stop(); busyRef.current = false; setBusy(false); setError(cause.message); } });
    camera.current = startCameraSession({ video: video.current, lightButton: lightButton.current,
      onStream: stream => {
        if (stream || epoch !== generation.current) return;
        cameraAvailable.current = false; setReady(false);
      },
      onFrame: () => {
        const source = video.current;
        if (epoch !== generation.current || !source?.videoWidth) return;
        cameraAvailable.current = true; setReady(true);
        if (busyRef.current || live.current.busy || autoPaused.current) return;
        const preview = readCameraFrame(source, canvas, { forGuidance: true });
        if (preview) live.current.scan(preview, { captureOnly: true });
      },
      onError: cause => { if (epoch === generation.current) { liveProgress.current?.stop(); cameraAvailable.current = false; cameraFailed.current = true; setError(`Camera could not open. ${cause.message} Choose a high-resolution photo instead.`); } } });
    return () => {
      generation.current++; pickerSession.current = null; cameraAvailable.current = false;
      picker.removeEventListener("cancel", resumePhotoPicker);
      progress.clear();
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
      if (!separateOriginal && !confirmsPageSeal(action, seals)) {
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
    setFailedPhoto(null);
    pickerSession.current = null;
    progress.clear(); liveProgress.current = null;
    scan.current?.abort(); scan.current = null;
    autoPaused.current = true;
    busyRef.current = false; setBusy(false);
  }
  function resumePhotoPicker() {
    const pending = pickerSession.current;
    pickerSession.current = null;
    // Dismissal resumes only the live camera that opened this picker. A late
    // cancel event must not reset a replacement file, closed dialog or error.
    if (!pending || pending.epoch !== generation.current || pending.camera !== camera.current
      || pending.live !== live.current || cameraFailed.current || scan.current || busyRef.current) return;
    autoPaused.current = false;
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
    acquisitionFailed.current = false; autoPaused.current = false;
    if (!preserveGate) live.current.reset();
    const controller = new AbortController(); scan.current = controller;
    const current = () => epoch === generation.current && scan.current === controller && !controller.signal.aborted;
    const canvas = document.createElement("canvas");
    captureDiagnostic.current = null;
    const attemptProgress = progress.begin(file ? "opening" : "capturing");
    const captureContext = file ? {} : cameraCaptureContext(
      { width: source.videoWidth, height: source.videoHeight }, preserveGate, lastQuality.current);
    let nativeBlob, burst;
    try {
      const options = { signal: controller.signal, requireHighResolution: true, onPhotoTaken: attemptProgress.photoReady,
        onBurst: separateOriginal ? undefined : blobs => { burst = blobs; },
        onPhotoBlob: blob => { nativeBlob = blob; }, onDiagnostic: diagnostic => {
        if (current()) captureDiagnostic.current = { ...diagnostic, ...captureContext };
      } };
      const still = file ? await readCameraPhotoFile(file, canvas, options)
        : await captureCameraPhoto(source, canvas, options);
      if (!current()) return;
      if (!still) {
        acquisitionFailed.current = true;
        // Automatic shots keep their page-movement gate. A manual failure must
        // not immediately become an automatic retry from a freshly reset gate.
        autoPaused.current = !preserveGate;
        setError(cameraPhotoFailure(captureDiagnostic.current).message);
        return;
      }
      attemptProgress.photoReady();
      if (separateOriginal) {
        // The recipient explicitly selected an authenticated page reference.
        // Its original may carry no QR. Only the later comparison evaluates it.
        await acceptFrame({}, canvas, epoch, controller);
        return;
      }
      const action = await scanPhotoInWorker(still, { returnPayload: true, burst, signal: controller.signal, onStage: attemptProgress.stage });
      if (!current()) return;
      if (action.timedOut) autoPaused.current = true;
      if (nativeBlob && (action.timedOut || action.status === "feedback")) setFailedPhoto(nativeBlob);
      await acceptFrame(cameraCaptureFeedback(action, captureDiagnostic.current), canvas, epoch, controller);
    } catch (cause) {
      if (current() && cause.name !== "AbortError") {
        if (nativeBlob) setFailedPhoto(nativeBlob);
        setError(cause.message);
      }
    }
    finally {
      attemptProgress.stop();
      canvas.width = canvas.height = 0;
      if (current()) { scan.current = null; busyRef.current = false; setBusy(false); }
    }
  }
  return <div className="page-camera-backdrop"><section className="page-camera" role="dialog" aria-modal="true"
    aria-label={title} tabIndex={-1} ref={dialog} onKeyDown={event => {
      if (event.key === "Escape") close();
      if (event.key === "Tab") {
        const buttons = [...dialog.current.querySelectorAll("button:not(:disabled)")];
        if (event.shiftKey && (document.activeElement === buttons[0] || document.activeElement === dialog.current)) {
          event.preventDefault(); buttons.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
      }
    }}>
    <h3>{title}</h3><p>{separateOriginal
      ? "Include all four corners of this original page. Its photo will be compared with the signed reference you selected."
      : "Frame all four corners and hold steady until QRed confirms the photo. You can also use Capture now or choose a high-resolution photo."}</p>
    <div style={{ position: "relative" }}><video ref={video} playsInline autoPlay muted />
      <CameraCaptureNotice progress={progress} />
      <div className="page-scan-guide-area" ref={guideArea} aria-hidden="true"><div className="page-scan-guide" ref={guide} hidden>
        <span /><span /><span /><span />
      </div></div></div>
    {!busy && !acquisitionFailed.current && quality && <p role="status">{quality.message}</p>}
    {!busy && !acquisitionFailed.current && quality?.state === "hold" && <progress className="capture-readiness" max="1" value={quality.progress} aria-label="Steady hold before automatic capture" />}
    <PhotoScanProgress progress={progress} />
    {error && <p role="alert">{error}</p>}
    <div className="photo-actions"><button type="button" disabled={!ready || busy} onClick={capture}>Capture now</button>
      <button type="button" ref={lightButton} hidden disabled={busy || undefined}>Flashlight off</button>
      <button type="button" onClick={choosePhoto}>Choose photo</button>
      {failedPhoto && <button type="button" onClick={() => downloadCameraPhoto(failedPhoto)}>Save scan photo</button>}
      <input ref={photoInput} type="file" accept="image/*" aria-label="Choose a high-resolution page photo" hidden onChange={event => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (file) capture({ file });
        else resumePhotoPicker();
      }} />
      <button type="button" onClick={close}>Cancel retake</button></div>
    <p className="photo-note">Camera photos stay on this device. QRed only saves a copy when you choose Save scan photo.</p>
  </section></div>;
}
