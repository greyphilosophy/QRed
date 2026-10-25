import React, { useCallback, useEffect, useRef, useState } from "react";
import { createQrFrameScanner, scanQrImage } from "./qr/scanQrImage.js";
import { decodeSeal, VISIBLE_QR_TEXT, qredTextFromPhotoScanResult, qredPayloadFromPhotoScanResult, qredTextFromScanResult } from "./qredVerifier.js";
import { isQRedEntryLink } from "./qr/hiddenPayload.js";
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
export function QrScanner({ onOpenPdfStampTool, onSealDetected, returnPayload = false, resultPanel,
  collectSeals = false, collectionProgress }) {
  const [mode, setMode] = useState("idle"); // "idle" | "scanning" | "result"
  const [scannedText, setScannedText] = useState(null);
  const [captureRequest, setCaptureRequest] = useState(0);
  const [torchEnabled, setTorchEnabled] = useState(false);
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

  const scanButtonLabel = mode === "scanning" ? "Scan photo" : mode === "result" ? "Scan again" : "Start scanning";
  const controls = React.createElement("div", { className: "ar-controls" },
    React.createElement("button", {
      className: "ar-button ar-button-primary",
      onClick: () => {
        if (mode === "scanning") {
          setCaptureRequest((request) => request + 1);
          return;
        }
        setScannedText(null);
        setMode("scanning");
      },
    }, scanButtonLabel),
    mode === "scanning" ? React.createElement("button", {
      "aria-pressed": torchEnabled,
      className: "ar-button ar-button-secondary",
      onClick: () => setTorchEnabled((enabled) => !enabled),
      type: "button",
    }, torchEnabled ? "Flashlight on" : "Flashlight off") : null,
    onOpenPdfStampTool ? React.createElement("button", {
      "aria-label": "Open PDF stamping tool",
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
        torchEnabled,
        returnPayload,
      }),
      collectionProgress ? React.createElement("p", { className: "ar-collection-progress", role: "status", "aria-live": "polite" }, collectionProgress.message) : null,
      controls
    );
  }

  return React.createElement("section", { className: "ar-display", "aria-label": "QRed AR scanner" },
    React.createElement("div", { className: "ar-idle" },
      React.createElement("div", { className: "ar-reticle", "aria-hidden": "true" },
        React.createElement("span", null),
        React.createElement("span", null),
        React.createElement("span", null),
        React.createElement("span", null)
      ),
      React.createElement("div", { className: "ar-copy" },
        React.createElement("p", { className: "eyebrow" }, "QRed AR verifier"),
        React.createElement("h1", null, "Point at a QRed seal"),
        React.createElement("p", null, "Scan a QR seal or a pale page watermark. Include the whole page when possible: the scan image is also kept for page comparison.")
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

export const QR_CAMERA_CONSTRAINTS = {
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
};

export function qrScanAction(imageData, width, height, code, { returnPayload = false } = {}) {
  if (!code?.data) return { status: "continue" };

  const text = returnPayload
    ? qredPayloadFromPhotoScanResult(imageData, width, height, code)
    : qredTextFromPhotoScanResult(imageData, width, height, code);

  if (text && !isQRedEntryLink(text)) return { status: "found", text };
  return { status: "continue" };
}

export function findPreferredZoomCamera(devices = []) {
  return devices.find((device) => device.kind === "videoinput" && /(telephoto|zoom|\b[23]x\b)/i.test(device.label || "")) || null;
}

export async function getPreferredCameraStream(mediaDevices = navigator.mediaDevices) {
  const stream = await mediaDevices.getUserMedia(QR_CAMERA_CONSTRAINTS);
  if (typeof mediaDevices.enumerateDevices !== "function") return stream;

  let preferredCamera;
  try {
    preferredCamera = findPreferredZoomCamera(await mediaDevices.enumerateDevices());
  } catch {
    return stream;
  }
  const [currentTrack] = stream.getVideoTracks?.() || [];
  if (!preferredCamera?.deviceId || currentTrack?.label === preferredCamera.label) return stream;

  try {
    const preferredStream = await mediaDevices.getUserMedia({
      video: {
        ...QR_CAMERA_CONSTRAINTS.video,
        deviceId: { exact: preferredCamera.deviceId },
      },
    });
    stream.getTracks().forEach((track) => track.stop());
    return preferredStream;
  } catch {
    return stream;
  }
}

export async function applyContinuousCameraFocus(stream) {
  return applyCameraQualityControls(stream);
}

export async function applyCameraQualityControls(stream, options = {}) {
  const [track] = stream?.getVideoTracks?.() || [];
  if (!track || typeof track.applyConstraints !== "function") return;

  const capabilities = typeof track.getCapabilities === "function" ? track.getCapabilities() : {};
  const advanced = [];
  if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes("continuous")) {
    advanced.push({ focusMode: "continuous" });
  }
  if (Array.isArray(capabilities.exposureMode) && capabilities.exposureMode.includes("continuous")) {
    advanced.push({ exposureMode: "continuous" });
  }
  if (Array.isArray(capabilities.whiteBalanceMode) && capabilities.whiteBalanceMode.includes("continuous")) {
    advanced.push({ whiteBalanceMode: "continuous" });
  }
  if (typeof options.enableTorch === "boolean" && capabilities.torch) {
    advanced.push({ torch: options.enableTorch });
  }
  if (typeof capabilities.zoom?.max === "number") {
    const minZoom = typeof capabilities.zoom.min === "number" ? capabilities.zoom.min : 1;
    const targetZoom = Math.max(minZoom, Math.min(options.zoomTarget || 2, capabilities.zoom.max));
    if (targetZoom > minZoom) advanced.push({ zoom: targetZoom });
  }

  if (advanced.length > 0) {
    try {
      await track.applyConstraints({ advanced });
    } catch {
      // Some mobile browsers advertise camera controls but reject them.
      // Keep scanning with the selected environment camera rather than failing.
    }
  }
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

export function decodeCanvasFrame(video, canvas, options = {}) {
  const manual = Boolean(options.manual);
  const returnPayload = Boolean(options.returnPayload);
  if (!isCameraFrameReady(video, canvas)) {
    return manual ? { status: "pending", message: "Camera is preparing the photo. Hold steady…" } : { status: "continue" };
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return { status: "continue" };

  const vWidth = video.videoWidth;
  const vHeight = video.videoHeight;

  // Cache canvas dimensions — only resize when video dimensions actually change
  const canvasNeedResize = canvas.width !== vWidth || canvas.height !== vHeight;
  if (canvasNeedResize) {
    canvas.width = vWidth;
    canvas.height = vHeight;
  }

  // Use the whole native frame for decoding and its saved page image.
  // The reticle is only an aiming guide. Keep recovery in this same frame.
  ctx.drawImage(video, 0, 0, vWidth, vHeight);
  const imageData = ctx.getImageData(0, 0, vWidth, vHeight);
  const code = !manual && options.scanQrFrame
    ? options.scanQrFrame(imageData.data, vWidth, vHeight)
    : scanQrImage(imageData.data, vWidth, vHeight, { tryRescaling: manual });

  if (manual && !code?.data) {
    return { status: "feedback", message: "No QR code found in this photo. Keep the whole seal in view, hold steady, and avoid glare. Then try again." };
  }
  if (manual && (code.data === VISIBLE_QR_TEXT || /QRED[34]:/.test(code.data) || code.data.includes("qred.org"))) {
    const text = returnPayload
      ? qredPayloadFromPhotoScanResult(imageData.data, vWidth, vHeight, code)
      : qredTextFromPhotoScanResult(imageData.data, vWidth, vHeight, code);
    if (text && !isQRedEntryLink(text)) return { status: "found", text };
    if (isQRedEntryLink(text) && code.data !== VISIBLE_QR_TEXT) {
      return { status: "feedback", message: "That code opens qred.org. Point at the pale watermark and include the whole square in view." };
    }
    if (code.data === VISIBLE_QR_TEXT) {
      return { status: "feedback", message: "QR code found, but no hidden QRed payload was detected. Move closer, improve lighting, and try again." };
    }
    return { status: "found", text: qredTextFromScanResult(code) };
  }

  return qrScanAction(imageData.data, vWidth, vHeight, code, { returnPayload });
}

function ScannerView({ onScan, onClose, captureRequest, torchEnabled, returnPayload }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const handleScanActionRef = useRef(() => false);
  const pendingManualCaptureRef = useRef(false);
  const pendingManualCaptureStartedAtRef = useRef(null);
  const cameraReadyRef = useRef(false);
  const streamRef = useRef(null);
  const torchEnabledRef = useRef(torchEnabled);
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

    handleScanActionRef.current = (scanAction) => {
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

    function scanFrame() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const frameReady = isCameraFrameReady(video, canvas);
      if (frameReady) markCameraReady(true);
      const timedOutManualCapture = pendingManualCaptureRef.current && !frameReady
        ? manualCapturePendingAction(pendingManualCaptureStartedAtRef.current)
        : null;
      const scanAction = timedOutManualCapture
        || (pendingManualCaptureRef.current && frameReady
          ? decodeCanvasFrame(video, canvas, { manual: true, returnPayload })
          : decodeCanvasFrame(video, canvas, { returnPayload, scanQrFrame }));
      if (pendingManualCaptureRef.current && (frameReady || timedOutManualCapture)) {
        pendingManualCaptureRef.current = false;
        pendingManualCaptureStartedAtRef.current = null;
      }
      handleScanActionRef.current(scanAction);
    }

    camera = startCameraSession({
      video: videoRef.current,
      requestStream: getPreferredCameraStream,
      prepareStream: stream => applyCameraQualityControls(stream, { enableTorch: torchEnabledRef.current }),
      onStream: stream => { streamRef.current = stream; },
      onFrame: scanFrame,
      onError: (error, stage) => setError((stage === "play" ? "Camera preview could not start: " : "Camera access needed: ")
        + (error.message || "environment camera")),
    });

    return () => {
      pendingManualCaptureRef.current = false;
      pendingManualCaptureStartedAtRef.current = null;
      cameraReadyRef.current = false;
      handleScanActionRef.current = () => false;
      camera.stop();
    };
  }, [onScan, returnPayload]);

  useEffect(() => {
    torchEnabledRef.current = torchEnabled;
    if (streamRef.current) applyCameraQualityControls(streamRef.current, { enableTorch: torchEnabled });
  }, [torchEnabled]);

  useEffect(() => {
    if (captureRequest <= 0 || error) return;

    const scanAction = decodeCanvasFrame(videoRef.current, canvasRef.current, { manual: true, returnPayload });
    handleScanActionRef.current(scanAction);
  }, [captureRequest, error, onScan]);

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
