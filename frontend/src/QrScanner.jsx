import React, { useCallback, useEffect, useRef, useState } from "react";
import { createQrFrameScanner, scanQrImage } from "./qr/scanQrImage.js";
import { decodeSeal } from "./qredVerifier.js";
import { decodePhoto, qrScanAction } from "./qr/decodePhoto.js";
import { preparePhotoScanner, scanPhotoInWorker } from "./qr/photoScanClient.js";
import { getPreferredCameraStream, applyCameraQualityControls } from "./qr/cameraControls.js";
export { QR_CAMERA_CONSTRAINTS, findPreferredMainCamera, getPreferredCameraStream,
  applyCameraQualityControls, applyContinuousCameraFocus } from "./qr/cameraControls.js";
export { qrScanAction } from "./qr/decodePhoto.js";
import { startCameraSession } from "./qr/cameraSession.js";
import "./qrScanner.css";

/**
 * QrScanner — Camera-based QR code scanner that can scan ANY QR code and
 * display its raw contents.
 *
 * Three states:
 * 1. Idle — shows the AR viewport and "Start scanning" button (user-initiated camera access)
 * 2. Scanning — camera feed + jsQR loop; collection mode waits for all pages
 * 3. Result — displays the scanned QR text, "New scan" resumes scanning
 */
export function QrScanner({ onOpenPdfStampTool, pdfStampToolOpen = false, onSealDetected, returnPayload = false, resultPanel,
  collectSeals = false, collectionProgress }) {
  const [mode, setMode] = useState("idle"); // "idle" | "scanning" | "result"
  const [scannedText, setScannedText] = useState(null);
  const [captureRequest, setCaptureRequest] = useState(0);
  const [readingPhoto, setReadingPhoto] = useState(false);
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

  const scanButtonLabel = mode === "scanning" ? (readingPhoto ? "Reading photo…" : "Scan photo") : mode === "result" ? "Scan again" : "Start scanning";
  const controls = React.createElement("div", { className: "ar-controls" },
    React.createElement("button", {
      className: "ar-button ar-button-primary",
      disabled: readingPhoto,
      onClick: () => {
        if (mode === "scanning") {
          setCaptureRequest((request) => request + 1);
          return;
        }
        setScannedText(null);
        setCaptureRequest(0);
        setMode("scanning");
      },
    }, scanButtonLabel),
    onOpenPdfStampTool ? React.createElement("button", {
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
    return React.createElement("section", { className: "ar-display", "aria-label": "QRed AR scanner" },
      React.createElement(ScannerView, {
        onScan: handleScan,
        onClose: () => setMode("idle"),
        captureRequest,
        onReadingPhoto: setReadingPhoto,
        returnPayload,
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
        React.createElement("h1", null, "Scan a QRed seal"),
        React.createElement("p", null, "Point your camera at a QR seal or pale page watermark. Include the whole page when possible.")
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
    message: "The camera is open, but this browser is not delivering photo frames yet. Wait a moment, then try Scan photo again; if this keeps happening, close and reopen the scanner or check camera permissions.",
  };
}

export function captureCameraFrame(video, canvas) {
  if (!isCameraFrameReady(video, canvas)) return null;
  const ctx = canvas.getContext("2d");
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
  // Synchronous entry point retained for decoder tests. The UI sends manual
  // captures to the worker and only runs bounded live-frame attempts here.
  if (options.manual) return decodePhoto(image, options);
  const { data, width, height } = image;
  const code = options.scanQrFrame ? options.scanQrFrame(data, width, height)
    : scanQrImage(data, width, height, { tryRescaling: false });
  if (code?.codes) {
    const texts = code.codes.map(result => qrScanAction(data, width, height, result, options))
      .filter(action => action.status === "found").map(action => action.text);
    return texts.length ? { status: "found-multiple", texts } : { status: "continue" };
  }
  return qrScanAction(data, width, height, code, options);
}

function ScannerView({ onScan, onClose, captureRequest, onReadingPhoto, returnPayload }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const handleScanActionRef = useRef(() => false);
  const pendingManualCaptureRef = useRef(false);
  const pendingManualCaptureStartedAtRef = useRef(null);
  const cameraReadyRef = useRef(false);
  const photoScanRef = useRef(null);
  const capturePhotoRef = useRef(() => {});
  const [error, setError] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [cameraReady, setCameraReady] = useState(false);

  function markCameraReady(ready) {
    if (cameraReadyRef.current === ready) return;
    cameraReadyRef.current = ready;
    setCameraReady(ready);
  }

  useEffect(() => {
    const seen = new Set();
    const scanQrFrame = createQrFrameScanner();
    let camera;
    preparePhotoScanner();

    handleScanActionRef.current = (scanAction) => {
      if (scanAction.status === "found-multiple") {
        let shouldStop = false;
        for (const text of scanAction.texts) {
          if (seen.has(text)) continue;
          seen.add(text);
          // All chunks share the same captured page photograph.
          if (!onScan(text, canvasRef.current)) { shouldStop = true; break; }
        }
        setFeedback(null);
        if (shouldStop) { camera.stop(); return true; }
        return false;
      }
      if (scanAction.status === "found") {
        if (seen.has(scanAction.text)) return false;
        seen.add(scanAction.text);
        // Haptic feedback on successful decode
        if (typeof navigator.vibrate === "function") {
          navigator.vibrate(80);
        }
        setFeedback(null);
        if (onScan(scanAction.text, canvasRef.current)) return false;
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
      setFeedback("Reading photo… You can close the scanner to cancel.");
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
    capturePhotoRef.current = capturePhoto;

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
      handleScanActionRef.current(timeout || decodeCanvasFrame(video, canvas, { returnPayload, scanQrFrame }));
    }

    camera = startCameraSession({
      video: videoRef.current,
      requestStream: getPreferredCameraStream,
      prepareStream: applyCameraQualityControls,
      onFrame: scanFrame,
      onError: (error, stage) => setError((stage === "play" ? "Camera preview could not start: " : "Camera access needed: ")
        + (error.message || "environment camera")),
    });

    return () => {
      pendingManualCaptureRef.current = false;
      pendingManualCaptureStartedAtRef.current = null;
      cameraReadyRef.current = false;
      handleScanActionRef.current = () => false;
      capturePhotoRef.current = () => {};
      photoScanRef.current?.abort();
      photoScanRef.current = null;
      onReadingPhoto(false);
      camera.stop();
    };
  }, [onScan, returnPayload, onReadingPhoto]);

  useEffect(() => {
    if (captureRequest > 0 && !error) capturePhotoRef.current();
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
    React.createElement("div", { className: "ar-reticle ar-reticle-live", "aria-hidden": "true" },
      React.createElement("span", null),
      React.createElement("span", null),
      React.createElement("span", null),
      React.createElement("span", null)
    ),
    React.createElement("canvas", { ref: canvasRef, style: { display: "none" } }),
    !cameraReady ? React.createElement(CameraLoadingIndicator, { message: feedback || "Starting camera…" }) : null,
    feedback && cameraReady ? React.createElement("div", { className: "ar-scan-feedback", role: "status", "aria-live": "polite" }, feedback) : null,
    React.createElement("button", { className: "ar-close", onClick: onClose }, "Close")
  );
}

function CameraLoadingIndicator({ message }) {
  return React.createElement("div", { "aria-label": message, className: "ar-camera-loading", role: "status", "aria-live": "polite" },
    React.createElement("span", { className: "ar-camera-spinner", "aria-hidden": "true" }),
    React.createElement("span", null, message)
  );
}
