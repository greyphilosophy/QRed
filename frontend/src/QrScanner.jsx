import React, { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { VISIBLE_QR_TEXT, extractHiddenQRedPayloadFromImage, qredTextFromScanResult } from "./qredVerifier.js";

/**
 * QrScanner — Camera-based QR code scanner that can scan ANY QR code and
 * display its raw contents.
 *
 * Three states:
 * 1. Idle — shows the AR viewport and "Start scanning" button (user-initiated camera access)
 * 2. Scanning — camera feed + jsQR loop
 * 3. Result — displays the scanned QR text, "New scan" resumes scanning
 */
export function QrScanner({ onOpenPdfStampTool }) {
  const [mode, setMode] = useState("idle"); // "idle" | "scanning" | "result"
  const [scannedText, setScannedText] = useState(null);
  const [captureRequest, setCaptureRequest] = useState(0);
  const [torchEnabled, setTorchEnabled] = useState(false);

  const scanButtonLabel = mode === "scanning" ? "Scan photo" : mode === "result" ? "Scan again" : "Start scanning";
  const controls = React.createElement("div", { className: "ar-controls" },
    React.createElement("button", {
      className: "ar-button ar-button-primary",
      onClick: () => {
        if (mode === "scanning") {
          setCaptureRequest((request) => request + 1);
          return;
        }
        setMode("scanning");
      },
    }, scanButtonLabel),
    mode === "scanning" ? React.createElement("button", {
      "aria-pressed": torchEnabled,
      className: "ar-button ar-button-secondary",
      onClick: () => setTorchEnabled((enabled) => !enabled),
      type: "button",
    }, torchEnabled ? "Flashlight on" : "Flashlight off") : null,
    React.createElement("button", {
      "aria-label": "Open PDF stamping tool",
      className: "ar-button ar-button-secondary",
      onClick: onOpenPdfStampTool,
      type: "button",
    },
      React.createElement("span", { "aria-hidden": "true", className: "stamp-icon" }, "▣"),
      React.createElement("span", null, "Stamp PDF")
    )
  );

  if (mode === "result") {
    return React.createElement("section", { className: "ar-display ar-display-result", "aria-label": "QRed AR scanner" },
      React.createElement(ResultPanel, { scannedText }),
      controls
    );
  }

  if (mode === "scanning") {
    return React.createElement("section", { className: "ar-display", "aria-label": "QRed AR scanner" },
      React.createElement(ScannerView, {
        onScan: (text) => {
          setScannedText(text);
          setMode("result");
        },
        onClose: () => setMode("idle"),
        captureRequest,
        torchEnabled,
      }),
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
        React.createElement("p", null, "Use your camera to scan and verify QR document seals.")
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

export function qrScanAction(imageData, width, height, code) {
  if (!code?.data) return { status: "continue" };

  const looksLikeQRed = code.data === VISIBLE_QR_TEXT || code.data.includes("QRED1") || code.data.includes("qred.org");
  const hiddenPayload = looksLikeQRed ? extractHiddenQRedPayloadFromImage(imageData, width, height, code) || qredTextFromScanResult(code) : null;
  if (hiddenPayload && hiddenPayload !== VISIBLE_QR_TEXT) return { status: "found", text: hiddenPayload };
  if (code.data !== VISIBLE_QR_TEXT) return { status: "found", text: qredTextFromScanResult(code) };

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

// ROI cropping: only decode the center 50% of the frame for jsQR
const ROI_FACTOR = 0.5;

function getROICropRegion(videoWidth, videoHeight) {
  const roiW = Math.floor(videoWidth * ROI_FACTOR);
  const roiH = Math.floor(videoHeight * ROI_FACTOR);
  const x = Math.floor((videoWidth - roiW) / 2);
  const y = Math.floor((videoHeight - roiH) / 2);
  return { x, y, width: roiW, height: roiH };
}

export function decodeCanvasFrame(video, canvas, options = {}) {
  const manual = Boolean(options.manual);
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

  // Draw only the ROI crop for performance (center 50%)
  const roi = getROICropRegion(vWidth, vHeight);
  ctx.drawImage(video, roi.x, roi.y, roi.width, roi.height, 0, 0, roi.width, roi.height);

  // Decode the ROI region for jsQR
  if (roi.width > 0 && roi.height > 0) {
    const imageData = ctx.getImageData(0, 0, roi.width, roi.height);
    const code = jsQR(imageData.data, roi.width, roi.height, { inversionAttempts: "attemptBoth" });

    if (manual && !code?.data) {
      return { status: "feedback", message: "No QR code found in this photo. Center a QR seal in the frame and try again." };
    }
    if (manual && (code.data === VISIBLE_QR_TEXT || code.data.includes("QRED1") || code.data.includes("qred.org"))) {
      const hiddenPayload = extractHiddenQRedPayloadFromImage(imageData.data, roi.width, roi.height, code);
      if (!hiddenPayload || hiddenPayload === VISIBLE_QR_TEXT) {
        if (code.data !== VISIBLE_QR_TEXT) return { status: "found", text: qredTextFromScanResult(code) };
        return { status: "feedback", message: "QR code found, but no hidden QRed payload was detected. Move closer, improve lighting, and try again." };
      }
      return { status: "found", text: hiddenPayload };
    }

    return qrScanAction(imageData.data, roi.width, roi.height, code);
  }

  return { status: "continue" };
}

function ScannerView({ onScan, onClose, captureRequest, torchEnabled }) {
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
  // Adaptive scan rate tracking
  const lastScanTimeRef = useRef(0);

  function markCameraReady(ready) {
    if (cameraReadyRef.current === ready) return;
    cameraReadyRef.current = ready;
    setCameraReady(ready);
  }

  useEffect(() => {
    let animId = null;
    let stream = null;
    let stopped = false;

    function stop() {
      stopped = true;
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
        streamRef.current = null;
      }
      const video = videoRef.current;
      if (video && video.srcObject) {
        video.srcObject = null;
      }
      if (animId !== null) {
        cancelAnimationFrame(animId);
        animId = null;
      }
    }

    handleScanActionRef.current = (scanAction) => {
      if (scanAction.status === "found") {
        setFeedback(null);
        stop();
        onScan(scanAction.text);
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
      if (stopped) return;

      // Throttle: gate at the top so we don't decode more than ~8fps
      const now = performance.now();
      const MIN_FRAME_INTERVAL_MS = 125;
      const nextFrameTime = lastScanTimeRef.current + MIN_FRAME_INTERVAL_MS;
      if (now < nextFrameTime) {
        setTimeout(scanFrame, nextFrameTime - now);
        return;
      }

      const video = videoRef.current;
      const canvas = canvasRef.current;
      const frameReady = isCameraFrameReady(video, canvas);
      if (frameReady) markCameraReady(true);
      const timedOutManualCapture = pendingManualCaptureRef.current && !frameReady
        ? manualCapturePendingAction(pendingManualCaptureStartedAtRef.current)
        : null;
      const scanAction = timedOutManualCapture
        || (pendingManualCaptureRef.current && frameReady
          ? decodeCanvasFrame(video, canvas, { manual: true })
          : decodeCanvasFrame(video, canvas));
      if (pendingManualCaptureRef.current && scanAction.status !== "pending") {
        pendingManualCaptureRef.current = false;
        pendingManualCaptureStartedAtRef.current = null;
      }
      if (handleScanActionRef.current(scanAction)) return;

      lastScanTimeRef.current = now;
      animId = requestAnimationFrame(scanFrame);
    }

    getPreferredCameraStream()
      .then(async (s) => {
        if (stopped) {
          s.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = s;
        streamRef.current = s;
        await applyCameraQualityControls(stream, { enableTorch: torchEnabledRef.current });
        if (stopped) return;
        const video = videoRef.current;
        video.srcObject = s;
        const playResult = video.play();
        if (playResult && typeof playResult.catch === "function") {
          playResult.catch((e) => {
            if (!stopped) setError("Camera preview could not start: " + (e.message || "tap Start scanning again"));
          });
        }
        scanFrame();
      })
      .catch((e) => {
        if (!stopped) {
          setError("Camera access needed: " + (e.message || "environment camera"));
        }
      });

    return () => {
      pendingManualCaptureRef.current = false;
      pendingManualCaptureStartedAtRef.current = null;
      cameraReadyRef.current = false;
      handleScanActionRef.current = () => false;
      stop();
    };
  }, [onScan]);

  useEffect(() => {
    torchEnabledRef.current = torchEnabled;
    if (streamRef.current) applyCameraQualityControls(streamRef.current, { enableTorch: torchEnabled });
  }, [torchEnabled]);

  useEffect(() => {
    if (captureRequest <= 0 || error) return;

    const scanAction = decodeCanvasFrame(videoRef.current, canvasRef.current, { manual: true });
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
