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
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
};

export function qrScanAction(imageData, width, height, code) {
  if (!code?.data) return { status: "continue" };
  if (code.data !== VISIBLE_QR_TEXT) return { status: "found", text: qredTextFromScanResult(code) };

  const hiddenPayload = extractHiddenQRedPayloadFromImage(imageData, width, height, code) || qredTextFromScanResult(code);
  if (hiddenPayload && hiddenPayload !== VISIBLE_QR_TEXT) return { status: "found", text: hiddenPayload };

  return { status: "continue" };
}

export async function applyContinuousCameraFocus(stream) {
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

  if (advanced.length > 0) {
    try {
      await track.applyConstraints({ advanced });
    } catch {
      // Some mobile browsers advertise camera focus controls but reject them.
      // Keep scanning with the selected environment camera rather than failing.
    }
  }
}

export function decodeCanvasFrame(video, canvas) {
  if (!video || !canvas || video.readyState !== 4) return { status: "continue" };

  const ctx = canvas.getContext("2d");
  if (!ctx) return { status: "continue" };

  if (video.videoWidth && video.videoHeight && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  if (!canvas.width || !canvas.height) return { status: "continue" };

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: "attemptBoth" });
  return qrScanAction(imageData.data, canvas.width, canvas.height, code);
}

function ScannerView({ onScan, onClose, captureRequest }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const handleScanActionRef = useRef(() => false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let animId = null;
    let stream = null;
    let stopped = false;

    function stop() {
      stopped = true;
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
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
        stop();
        onScan(scanAction.text);
        return true;
      }
      return false;
    };

    function scanFrame() {
      if (stopped) return;

      const scanAction = decodeCanvasFrame(videoRef.current, canvasRef.current);
      if (handleScanActionRef.current(scanAction)) return;

      animId = requestAnimationFrame(scanFrame);
    }

    navigator.mediaDevices.getUserMedia(QR_CAMERA_CONSTRAINTS)
      .then(async (s) => {
        if (stopped) {
          s.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = s;
        await applyContinuousCameraFocus(stream);
        if (stopped) return;
        const video = videoRef.current;
        video.srcObject = s;
        video.play();
        scanFrame();
      })
      .catch((e) => {
        if (!stopped) {
          setError("Camera access needed: " + (e.message || "environment camera"));
        }
      });

    return () => {
      handleScanActionRef.current = () => false;
      stop();
    };
  }, [onScan]);

  useEffect(() => {
    if (captureRequest <= 0 || error) return;

    const scanAction = decodeCanvasFrame(videoRef.current, canvasRef.current);
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
    React.createElement("button", { className: "ar-close", onClick: onClose }, "Close")
  );
}
