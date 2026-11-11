import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { scanQrImage } from "./qr/scanQrImage.js";
import { decodeSeal } from "./qredVerifier.js";
import { decodePhoto, qrFrameAction } from "./qr/decodePhoto.js";
import { createLiveScanWorker, preparePhotoScanner, scanPhotoInWorker } from "./qr/photoScanClient.js";
import { getPreferredCameraStream, applyCameraQualityControls } from "./qr/cameraControls.js";
export { QR_CAMERA_CONSTRAINTS, findPreferredMainCamera, getPreferredCameraStream,
  applyCameraQualityControls, applyContinuousCameraFocus } from "./qr/cameraControls.js";
export { qrScanAction } from "./qr/decodePhoto.js";
import { startCameraSession } from "./qr/cameraSession.js";
import { observePageScanGuide } from "./qr/pageScanGuide.js";
import { CameraCaptureNotice, PhotoScanProgress, usePhotoScanProgress } from "./qr/PhotoScanProgress.jsx";
import { readCameraFrame, canCaptureCameraPhoto, captureCameraPhoto, cameraFrameDiagnostic, cameraCaptureFeedback, cameraPhotoFailure, cameraCaptureContext, downloadCameraPhoto } from "./qr/cameraPhoto.js";
import "./qrScanner.css";

/**
 * QrScanner — Camera-based QR code scanner that can scan ANY QR code and
 * display its raw contents.
 *
 * Three states:
 * 1. Idle — prepares text checking, then opens the camera on user request
 * 2. Scanning — camera feed + worker decoding; collection mode waits for all pages
 * 3. Result — shows collection progress and can resume scanning
 */
export function QrScanner({ onOpenPdfStampTool, pdfStampToolOpen = false, onSealDetected, returnPayload = false, resultPanel,
  collectSeals = false, collectionProgress, beforeScan, onScanningChange, onChoosePhoto, completionNotice = "" }) {
  const [mode, setMode] = useState("idle"); // "idle" | "scanning" | "result"
  const [scannedText, setScannedText] = useState(null);
  const [captureRequest, setCaptureRequest] = useState(0);
  const [readingPhoto, setReadingPhoto] = useState(false);
  const [preparing, setPreparing] = useState(false), [preparationError, setPreparationError] = useState("");
  const startGeneration = useRef(0);
  const startingCollection = useRef(null);
  const startButton = useRef(null);
  useEffect(() => () => { startGeneration.current++; }, []);
  useEffect(() => { if (completionNotice) startButton.current?.focus(); }, [completionNotice]);
  useEffect(() => { onScanningChange?.(mode === "scanning"); }, [mode, onScanningChange]);
  const handleScan = useCallback((text, frame) => {
    onSealDetected?.(text, frame);
    setScannedText(text);
    const keepScanning = collectSeals && Boolean(decodeSeal(text));
    if (!keepScanning) setMode("result");
    return keepScanning;
  }, [onSealDetected, collectSeals]);

  useEffect(() => {
    // A file or PDF can finish the same collection while the camera is open.
    // Stop from collection state, not from the last camera-only callback.
    // Starting another scan after a finished collection must still be possible.
    if (mode === "scanning" && collectSeals && collectionProgress?.finished
      && (!startingCollection.current?.finished
        || startingCollection.current.activeSeal !== collectionProgress.activeSeal)) setMode("result");
  }, [mode, collectSeals, collectionProgress]);

  const scanButtonLabel = preparing ? "Preparing check…" : mode === "scanning" ? (readingPhoto ? "Cancel and resume camera" : "Capture now") : mode === "result" ? "Scan more pages" : "Check document";
  const controls = React.createElement("div", { className: "ar-controls" },
    React.createElement("button", {
      className: "ar-button ar-button-primary",
      ref: startButton,
      "aria-describedby": completionNotice ? "check-clear-note" : undefined,
      disabled: preparing,
      onClick: async () => {
        if (mode === "scanning") {
          setCaptureRequest((request) => request + 1);
          return;
        }
        const generation = ++startGeneration.current;
        if (beforeScan) {
          setPreparing(true); setPreparationError("");
          try { await beforeScan(); }
          catch (error) { if (generation === startGeneration.current) { setPreparing(false); setPreparationError(error.message); } return; }
          if (generation !== startGeneration.current) return;
          setPreparing(false);
        }
        startingCollection.current = collectionProgress;
        setScannedText(null);
        setCaptureRequest(0);
        setMode("scanning");
      },
    }, scanButtonLabel),
    mode === "scanning" && onChoosePhoto ? React.createElement("button", {
      className: "ar-button ar-button-secondary", onClick: () => { setMode("idle"); onChoosePhoto(); },
    }, "Choose photo") : null,
    mode === "scanning" && collectSeals && collectionProgress?.pagesCollected > 0 ? React.createElement("button", {
      className: "ar-button ar-button-secondary", onClick: () => {
        setMode("result");
        document.getElementById("document-check")?.scrollIntoView({ behavior: "smooth" });
      },
    }, collectionProgress?.pagesCollected > 1 ? "Check captured pages now" : "Check this page now") : null,
    onOpenPdfStampTool && mode !== "scanning" ? React.createElement("button", {
      "aria-label": "Open PDF stamping tool",
      "aria-controls": "pdf-stamp-tool",
      "aria-expanded": pdfStampToolOpen,
      className: "ar-button ar-button-secondary",
      onClick: onOpenPdfStampTool,
      type: "button",
    },
      React.createElement("span", { "aria-hidden": "true", className: "stamp-icon" }, "▣"),
      React.createElement("span", null, "Stamp PDF")
    ) : null
  );

  if (mode === "result") {
    return React.createElement("section", { className: "ar-display ar-display-result", "aria-label": "QRed AR scanner" },
      resultPanel ?? React.createElement(ResultPanel, { scannedText }),
      controls
    );
  }

  if (mode === "scanning") {
    return React.createElement("section", { className: "ar-display ar-display-scanning", "aria-label": "QRed AR scanner" },
      React.createElement(ScannerView, {
        onScan: handleScan,
        onClose: () => setMode("idle"),
        captureRequest,
        onReadingPhoto: setReadingPhoto,
        returnPayload,
        autoCapture: collectSeals,
      }),
      collectionProgress ? React.createElement("p", { className: "ar-collection-progress", role: "status", "aria-live": "polite" }, collectionProgress.message) : null,
      controls
    );
  }

  return React.createElement("section", { className: "ar-display ar-display-idle", "aria-label": "QRed AR scanner" },
    React.createElement("div", { className: "ar-idle" },
      React.createElement("div", { className: "ar-reticle", "aria-hidden": "true" },
        React.createElement("span", null),
        React.createElement("span", null),
        React.createElement("span", null),
        React.createElement("span", null)
      ),
      React.createElement("div", { className: "ar-copy" },
        React.createElement("p", { className: "eyebrow" }, "QRed AR verifier"),
        React.createElement("h1", null, "Check a printed document"),
        React.createElement("p", null, "Frame the whole page and hold steady. QRed captures automatically and tells you when you can move."),
        React.createElement("p", { className: "camera-privacy" }, "Camera photos stay on this device. QRed only saves a copy when you choose Save scan photo."),
        completionNotice ? React.createElement("p", { id: "check-clear-note", role: "status" }, completionNotice) : null,
        preparationError ? React.createElement("p", { role: "alert" }, preparationError + " Try Check document again while connected.") : null
      )
    ),
    controls
  );
}

function ResultPanel({ scannedText }) {
  return React.createElement("div", { className: "ar-result-panel" },
    React.createElement("h2", null, "QR Code Content"),
    React.createElement("div", { className: "doc-text" }, scannedText)
  );
}

export const MANUAL_CAPTURE_PENDING_TIMEOUT_MS = 4000;

export function isCameraFrameReady(video, canvas) {
  return Boolean(video && canvas && video.readyState >= 2 && video.videoWidth && video.videoHeight);
}

export function manualCapturePendingAction(startedAt, now = performance.now()) {
  if (typeof startedAt !== "number") return null;
  if (now - startedAt < MANUAL_CAPTURE_PENDING_TIMEOUT_MS) return null;
  return {
    status: "feedback",
    message: "The camera is open, but this browser is not delivering photo frames yet. Wait a moment, then try Capture now again; if this keeps happening, close and reopen the scanner or check camera permissions.",
  };
}

export function captureCameraFrame(video, canvas, options) {
  if (!isCameraFrameReady(video, canvas)) return null;
  const pixels = readCameraFrame(video, canvas, options);
  return pixels && { data: pixels.data, width: canvas.width, height: canvas.height };
}

export function decodeCanvasFrame(video, canvas, options = {}) {
  const image = captureCameraFrame(video, canvas);
  if (!image) return options.manual
    ? { status: "pending", message: "Camera is preparing the photo. Hold steady…" }
    : { status: "continue" };
  // Synchronous entry point retained for decoder tests. The UI sends both
  // live frames and explicit still captures to their background workers.
  if (options.manual) return decodePhoto(image, options);
  const { data, width, height } = image;
  const code = options.scanQrFrame ? options.scanQrFrame(data, width, height)
    : scanQrImage(data, width, height, { tryRescaling: false });
  return qrFrameAction(image, code, options);
}

function ScannerView({ onScan, onClose, captureRequest, onReadingPhoto, returnPayload, autoCapture }) {
  const progress = usePhotoScanProgress();
  const progressSnapshot = useSyncExternalStore(progress.subscribe, progress.getSnapshot, progress.getSnapshot);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const guideAreaRef = useRef(null);
  const guideRef = useRef(null);
  const handleScanActionRef = useRef(() => false);
  const pendingManualCaptureRef = useRef(false);
  const pendingManualCaptureStartedAtRef = useRef(null);
  const cameraReadyRef = useRef(false);
  const photoScanRef = useRef(null);
  const photoActionRef = useRef(() => {});
  const [error, setError] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [quality, setQuality] = useState(null);
  const [failedPhoto, setFailedPhoto] = useState(null);

  function markCameraReady(ready) {
    if (cameraReadyRef.current === ready) return;
    cameraReadyRef.current = ready;
    setCameraReady(ready);
  }

  useEffect(() => {
    const seen = new Set();
    let activeProgress = null;
    let captureReported = false;
    let processingCapture = false;
    let captureDiagnostic = null;
    let lastQuality = null;
    let autoPaused = false;
    const capturedCanvas = canvasRef.current;
    let camera;
    const stopGuide = observePageScanGuide(videoRef.current, guideAreaRef.current, guideRef.current);
    preparePhotoScanner();
    const liveScan = createLiveScanWorker({
      returnPayload,
      requirePageQuality: autoCapture,
      onQuality: quality => {
        lastQuality = { state: quality.state };
        setQuality(quality);
        if (!quality.ready && captureReported) { captureReported = false; setFeedback(null); }
      },
      onCaptured: ({ captureOnly } = {}) => {
        if (autoPaused) return;
        if (captureOnly) { capturePhoto(true); return; }
        processingCapture = true;
        captureDiagnostic = cameraFrameDiagnostic(canvasRef.current);
        activeProgress = progress.begin("captured");
        setFeedback(null);
        onReadingPhoto(true);
      },
      onStage: stage => activeProgress?.stage(stage),
      onResult: action => {
        if (processingCapture) activeProgress?.stop();
        if (processingCapture) { processingCapture = false; onReadingPhoto(false); }
        handleScanActionRef.current(action);
      },
      onError: error => { activeProgress?.stop(); processingCapture = false; onReadingPhoto(false); camera.stop(); setError(error.message); },
    });

    handleScanActionRef.current = (scanAction) => {
      scanAction = cameraCaptureFeedback(scanAction, captureDiagnostic);
      if (scanAction.status === "found-multiple") {
        captureReported = true;
        let shouldStop = false, added = false;
        for (const text of scanAction.texts) {
          if (seen.has(text)) continue;
          seen.add(text);
          added = true;
          // All chunks share the same captured page photograph.
          if (!onScan(text, canvasRef.current)) { shouldStop = true; break; }
        }
        setFeedback(scanAction.timedOut ? scanAction.message
          : added ? "Page captured. Show the next page." : "This page is already captured. Show the next page.");
        if (added && typeof navigator.vibrate === "function") navigator.vibrate(80);
        if (shouldStop) { camera.stop(); return true; }
        return false;
      }
      if (scanAction.status === "found") {
        captureReported = true;
        if (seen.has(scanAction.text)) { setFeedback("This page is already captured. Show the next page."); return false; }
        seen.add(scanAction.text);
        // onScan copies the original pixels before the feedback can shake the camera.
        const keepScanning = onScan(scanAction.text, canvasRef.current);
        if (typeof navigator.vibrate === "function") navigator.vibrate(80);
        setFeedback("Page captured. Show the next page.");
        if (keepScanning) return false;
        camera.stop();
        return true;
      }
      if (scanAction.status === "feedback") {
        setFeedback(scanAction.message);
      }
      if (scanAction.status === "pending") {
        pendingManualCaptureRef.current = true;
        pendingManualCaptureStartedAtRef.current ??= performance.now();
        setFeedback(scanAction.message);
        markCameraReady(false);
      }
      return false;
    };

    function capturePhoto(preserveGate = false) {
      if (photoScanRef.current) return;
      setFailedPhoto(null);
      // A queued live result must never be attached to the new still photo.
      if (!preserveGate) liveScan.reset();
      captureDiagnostic = null;
      autoPaused = false;
      activeProgress?.stop();
      const attemptProgress = progress.begin("capturing");
      activeProgress = attemptProgress;
      let image;
      try { image = captureCameraFrame(videoRef.current, canvasRef.current); }
      catch {
        attemptProgress.stop();
        pendingManualCaptureRef.current = false;
        pendingManualCaptureStartedAtRef.current = null;
        autoPaused = autoCapture && !preserveGate;
        onReadingPhoto(false);
        setFeedback("The camera frame could not be read. Try Capture now again, or choose a photo.");
        return;
      }
      if (!image) {
        attemptProgress.stop();
        handleScanActionRef.current({ status: "pending", message: "Camera is preparing the photo. Hold steady…" });
        return;
      }
      pendingManualCaptureRef.current = false;
      pendingManualCaptureStartedAtRef.current = null;
      markCameraReady(true);
      const controller = new AbortController();
      photoScanRef.current = controller;
      onReadingPhoto(true);
      const nativePhoto = canCaptureCameraPhoto(videoRef.current);
      const captureContext = cameraCaptureContext(image, preserveGate, lastQuality);
      captureDiagnostic = cameraFrameDiagnostic(image);
      setFeedback(null);
      let nativeBlob;
      const read = async () => {
        const still = nativePhoto ? await captureCameraPhoto(videoRef.current, canvasRef.current,
          { signal: controller.signal, requireHighResolution: autoCapture, onPhotoBlob: blob => { nativeBlob = blob; }, onDiagnostic: diagnostic => {
            if (photoScanRef.current === controller) captureDiagnostic = { ...diagnostic, ...captureContext };
          } }) : null;
        controller.signal.throwIfAborted();
        if (autoCapture && !still) return cameraPhotoFailure(captureDiagnostic);
        attemptProgress.phase("captured");
        return scanPhotoInWorker(still || image, { returnPayload, signal: controller.signal, onStage: attemptProgress.stage });
      };
      read().then(action => {
        if (photoScanRef.current !== controller) return;
        if (nativeBlob && (action.timedOut || action.status === "feedback")) setFailedPhoto(nativeBlob);
        autoPaused = autoCapture && (action.timedOut || (!preserveGate && action.captureFailed));
        setFeedback(null);
        handleScanActionRef.current(action);
      }).catch(error => {
        if (photoScanRef.current === controller && error.name !== "AbortError") {
          if (nativeBlob) setFailedPhoto(nativeBlob);
          autoPaused = autoCapture && !preserveGate;
          setFeedback(error.message);
        }
      }).finally(() => {
        attemptProgress.stop();
        if (photoScanRef.current !== controller) return;
        photoScanRef.current = null;
        onReadingPhoto(false);
      });
    }
    photoActionRef.current = () => {
      activeProgress?.stop();
      if (processingCapture) {
        processingCapture = false; liveScan.reset();
        onReadingPhoto(false); setFeedback(null); setQuality(null);
        return;
      }
      if (!photoScanRef.current) { capturePhoto(); return; }
      const controller = photoScanRef.current;
      photoScanRef.current = null;
      controller.abort();
      onReadingPhoto(false);
      setFeedback(null);
    };

    function scanFrame() {
      // Preserve the photographed canvas until its worker result is collected.
      if (photoScanRef.current || autoPaused) return;
      const video = videoRef.current, canvas = canvasRef.current;
      const frameReady = isCameraFrameReady(video, canvas);
      if (frameReady) markCameraReady(true);
      if (pendingManualCaptureRef.current && frameReady) { capturePhoto(); return; }
      const timeout = pendingManualCaptureRef.current
        ? manualCapturePendingAction(pendingManualCaptureStartedAtRef.current) : null;
      if (timeout) {
        pendingManualCaptureRef.current = false;
        pendingManualCaptureStartedAtRef.current = null;
      }
      if (timeout) { handleScanActionRef.current(timeout); return; }
      if (!frameReady || liveScan.busy) return;
      const image = captureCameraFrame(video, canvas, { forGuidance: autoCapture });
      if (image) liveScan.scan(image, { captureOnly: autoCapture || canCaptureCameraPhoto(video) });
    }

    camera = startCameraSession({
      video: videoRef.current,
      requestStream: getPreferredCameraStream,
      prepareStream: applyCameraQualityControls,
      onFrame: scanFrame,
      onError: (error, stage) => {
        activeProgress?.stop();
        liveScan.stop();
        setError((stage === "play" ? "Camera preview could not start: " : "Camera access needed: ")
          + (error.message || "environment camera"));
      },
    });

    return () => {
      progress.clear();
      pendingManualCaptureRef.current = false;
      pendingManualCaptureStartedAtRef.current = null;
      cameraReadyRef.current = false;
      handleScanActionRef.current = () => false;
      photoActionRef.current = () => {};
      photoScanRef.current?.abort();
      photoScanRef.current = null;
      onReadingPhoto(false);
      camera.stop();
      liveScan.stop();
      if (capturedCanvas) capturedCanvas.width = capturedCanvas.height = 0;
      stopGuide();
    };
  }, [onScan, returnPayload, onReadingPhoto, autoCapture, progress]);

  useEffect(() => {
    if (captureRequest > 0 && !error) photoActionRef.current();
  }, [captureRequest, error]);

  if (error) {
    return React.createElement("div", { className: "ar-error" },
      React.createElement("h2", null, "Camera unavailable"),
      React.createElement("p", null, error),
      React.createElement("button", { onClick: onClose, style: { marginTop: "1rem" }}, "Close")
    );
  }

  return React.createElement("div", { className: "ar-camera" },
    React.createElement("video", {
      ref: videoRef,
      playsInline: true,
      autoPlay: true,
    }),
    React.createElement(CameraCaptureNotice, { progress }),
    React.createElement("div", { className: "page-scan-guide-area", ref: guideAreaRef, "aria-hidden": "true" },
      React.createElement("div", { className: "page-scan-guide", ref: guideRef, hidden: true },
        React.createElement("span", null),
        React.createElement("span", null),
        React.createElement("span", null),
        React.createElement("span", null)
      )
    ),
    React.createElement("canvas", { ref: canvasRef, style: { display: "none" } }),
    !cameraReady ? React.createElement(CameraLoadingIndicator, { message: feedback || "Starting camera…" }) : null,
    React.createElement(PhotoScanProgress, { progress }),
    cameraReady && !progressSnapshot ? React.createElement("div", { className: "ar-scan-feedback", role: "status", "aria-live": "polite" },
      quality && !feedback ? React.createElement("span", null, quality.message) : null,
      feedback ? React.createElement("span", null, feedback) : null,
      failedPhoto ? React.createElement("button", { type: "button", className: "save-scan-photo",
        onClick: () => downloadCameraPhoto(failedPhoto) }, "Save scan photo") : null,
      !quality && !feedback ? "Keep all four page corners visible. Avoid glare." : null,
      quality?.state === "hold" && !feedback ? React.createElement("progress", { className: "capture-readiness", max: 1,
        value: quality.progress, "aria-label": "Steady hold before automatic capture" }) : null) : null,
    React.createElement("button", { className: "ar-close", onClick: onClose }, "Close")
  );
}

function CameraLoadingIndicator({ message }) {
  return React.createElement("div", { "aria-label": message, className: "ar-camera-loading", role: "status", "aria-live": "polite" },
    React.createElement("span", { className: "ar-camera-spinner", "aria-hidden": "true" }),
    React.createElement("span", null, message)
  );
}
