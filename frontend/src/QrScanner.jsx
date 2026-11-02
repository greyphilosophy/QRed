import React, { useCallback, useEffect, useRef, useState } from "react";
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
import { photoProcessingMessage } from "./verifier/photoStatus.js";
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
  collectSeals = false, collectionProgress, beforeScan, onScanningChange, completionNotice = "" }) {
  const [mode, setMode] = useState("idle"); // "idle" | "scanning" | "result"
  const [scannedText, setScannedText] = useState(null);
  const [captureRequest, setCaptureRequest] = useState(0);
  const [readingPhoto, setReadingPhoto] = useState(false);
  const [preparing, setPreparing] = useState(false), [preparationError, setPreparationError] = useState("");
  const startGeneration = useRef(0);
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
    if (mode === "scanning" && scannedText && collectionProgress?.finished
      && collectionProgress.activeSeal === scannedText) setMode("result");
  }, [mode, scannedText, collectionProgress]);

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
        setScannedText(null);
        setCaptureRequest(0);
        setMode("scanning");
      },
    }, scanButtonLabel),
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
        React.createElement("p", null, "Frame each whole page and hold steady. QRed captures automatically, then checks the seal and printed text."),
        React.createElement("p", { className: "camera-privacy" }, "Camera images stay in this session. QRed does not save them to your photo library or upload them."),
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

export function captureCameraFrame(video, canvas) {
  if (!isCameraFrameReady(video, canvas)) return null;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const width = video.videoWidth, height = video.videoHeight;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx.drawImage(video, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height);
  return { data: pixels.data, width, height };
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

  function markCameraReady(ready) {
    if (cameraReadyRef.current === ready) return;
    cameraReadyRef.current = ready;
    setCameraReady(ready);
  }

  useEffect(() => {
    const seen = new Set();
    let captureReported = false;
    let processingCapture = false;
    const capturedCanvas = canvasRef.current;
    let camera;
    const stopGuide = observePageScanGuide(videoRef.current, guideAreaRef.current, guideRef.current);
    preparePhotoScanner();
    const liveScan = createLiveScanWorker({
      returnPayload,
      requirePageQuality: autoCapture,
      onQuality: quality => {
        setQuality(quality); stopGuide.update(quality);
        if (!quality.ready && captureReported) { captureReported = false; setFeedback(null); }
      },
      onCaptured: () => {
        processingCapture = true;
        setFeedback(photoProcessingMessage());
        onReadingPhoto(true);
      },
      onResult: action => {
        if (processingCapture) { processingCapture = false; onReadingPhoto(false); }
        handleScanActionRef.current(action);
      },
      onError: error => { processingCapture = false; onReadingPhoto(false); camera.stop(); setError(error.message); },
    });

    handleScanActionRef.current = (scanAction) => {
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
        setFeedback(added ? "Page captured. Show the next page." : "This page is already captured. Show the next page.");
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

    function capturePhoto() {
      if (photoScanRef.current) return;
      // A queued live result must never be attached to the new still photo.
      liveScan.reset();
      const image = captureCameraFrame(videoRef.current, canvasRef.current);
      if (!image) {
        handleScanActionRef.current({ status: "pending", message: "Camera is preparing the photo. Hold steady…" });
        return;
      }
      pendingManualCaptureRef.current = false;
      pendingManualCaptureStartedAtRef.current = null;
      markCameraReady(true);
      const controller = new AbortController();
      photoScanRef.current = controller;
      onReadingPhoto(true);
      setFeedback(photoProcessingMessage());
      scanPhotoInWorker(image, { returnPayload, signal: controller.signal }).then(action => {
        if (photoScanRef.current !== controller) return;
        setFeedback(null);
        handleScanActionRef.current(action);
      }).catch(error => {
        if (photoScanRef.current === controller && error.name !== "AbortError") setFeedback(error.message);
      }).finally(() => {
        if (photoScanRef.current !== controller) return;
        photoScanRef.current = null;
        onReadingPhoto(false);
      });
    }
    photoActionRef.current = () => {
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
      if (photoScanRef.current) return;
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
      const image = captureCameraFrame(video, canvas);
      if (image) liveScan.scan(image);
    }

    camera = startCameraSession({
      video: videoRef.current,
      requestStream: getPreferredCameraStream,
      prepareStream: applyCameraQualityControls,
      onFrame: scanFrame,
      onError: (error, stage) => {
        liveScan.stop();
        setError((stage === "play" ? "Camera preview could not start: " : "Camera access needed: ")
          + (error.message || "environment camera"));
      },
    });

    return () => {
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
  }, [onScan, returnPayload, onReadingPhoto, autoCapture]);

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
    cameraReady ? React.createElement("div", { className: "ar-scan-feedback", role: "status", "aria-live": "polite" },
      quality && !feedback ? React.createElement("span", null, quality.message) : null,
      feedback ? React.createElement("span", null, feedback) : null,
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
