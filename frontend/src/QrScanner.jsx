import React, { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { isQRedSeal, parseQRedSeal } from "./qredFragment.js";

/**
 * QrScanner — Camera-based QR code scanner that can scan ANY QR code and
 * display its contents. For QRED1? format codes, shows structured metadata
 * using the shared qredFragment parser. For plain text, shows the raw content.
 *
 * Three states:
 * 1. Idle — shows the AR viewport and "Start scanning" button (user-initiated camera access)
 * 2. Scanning — camera feed + jsQR loop
 * 3. Result — displays the scanned QR text, "New scan" resumes scanning
 */
export function QrScanner({ onOpenPdfStampTool }) {
  const [mode, setMode] = useState("idle"); // "idle" | "scanning" | "result"
  const [scannedText, setScannedText] = useState(null);

  const controls = React.createElement("div", { className: "ar-controls" },
    React.createElement("button", {
      className: "ar-button ar-button-primary",
      onClick: () => setMode("scanning"),
    }, mode === "result" ? "Scan again" : "Start scanning"),
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
  if (scannedText && isQRedSeal(scannedText)) {
    const sealData = parseQRedSeal(scannedText);
    return React.createElement("div", { className: "ar-result-panel" },
      React.createElement("h2", null, "QRed Document Data"),
      React.createElement("div", { className: "doc-text" }, sealData?.text || scannedText),
      (sealData?.issuer || sealData?.documentId)
        ? React.createElement("div", { className: "fragment-meta" },
            sealData.issuer && React.createElement("div", { className: "meta-row" },
              React.createElement("span", { className: "meta-label" }, "Issuer:"),
              React.createElement("span", null, sealData.issuer)
            ),
            sealData.documentId && React.createElement("div", { className: "meta-row" },
              React.createElement("span", { className: "meta-label" }, "Document ID:"),
              React.createElement("span", null, sealData.documentId)
            )
          )
        : null
    );
  }

  return React.createElement("div", { className: "ar-result-panel" },
    React.createElement("h2", null, "QR Code Content"),
    React.createElement("div", { className: "doc-text" }, scannedText)
  );
}

function ScannerView({ onScan, onClose }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
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

    function scanFrame() {
      if (stopped) return;

      const video = videoRef.current;
      if (video && video.readyState === 4) {
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext("2d");
          if (video.videoWidth && video.videoHeight && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
          }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, canvas.width, canvas.height, { inverted: false });
          if (code && code.data) {
            stop();
            onScan(code.data);
            return;
          }
        }
      }
      animId = requestAnimationFrame(scanFrame);
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = s;
        const video = videoRef.current;
        video.srcObject = s;
        video.play();
        scanFrame();
      })
      .catch((e) => {
        if (!stopped) {
          setError("Camera access needed: " + (e.message || "facingMode: environment"));
        }
      });

    return stop;
  }, [onScan]);

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
