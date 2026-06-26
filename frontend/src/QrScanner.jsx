import React, { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { isQRedSeal, parseQRedSeal } from "./qredFragment.js";

/**
 * QrScanner — Camera-based QR code scanner that can scan ANY QR code and
 * display its contents. For QRED1? format codes, shows structured metadata
 * using the shared qredFragment parser. For plain text, shows the raw content.
 *
 * Three states:
 * 1. Idle — shows "Scan QR Code" button (user-initiated camera access)
 * 2. Scanning — camera feed + jsQR loop
 * 3. Result — displays the scanned QR text, "New scan" resets to idle
 */
export function QrScanner() {
  const [mode, setMode] = useState("idle"); // "idle" | "scanning" | "result"
  const [scannedText, setScannedText] = useState(null);

  if (mode === "result") {
    if (scannedText && isQRedSeal(scannedText)) {
      const sealData = parseQRedSeal(scannedText);
      return React.createElement("div", { className: "card qr-scan-result" },
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
          : null,
        React.createElement("button", {
          onClick: () => {
            setMode("idle");
            setScannedText(null);
          },
          style: { marginTop: "1rem" }
        }, "New scan")
      );
    }

    return React.createElement("div", { className: "card qr-scan-result" },
      React.createElement("h2", null, "QR Code Content"),
      React.createElement("div", { className: "doc-text" }, scannedText),
      React.createElement("button", {
        onClick: () => {
          setMode("idle");
          setScannedText(null);
        },
        style: { marginTop: "1rem" }
      }, "New scan")
    );
  }

  if (mode === "scanning") {
    return React.createElement(ScannerView, {
      onScan: (text) => {
        setScannedText(text);
        setMode("result");
      },
      onClose: () => setMode("idle"),
    });
  }

  return React.createElement("div", { className: "card" },
    React.createElement("h2", null, "QR Code Scanner"),
    React.createElement("p", { style: { color: "#64748b", marginBottom: "1rem" }},
      "Scan any QR code to view its contents, including QRed seals."
    ),
    React.createElement("button", {
      onClick: () => setMode("scanning"),
      style: { marginTop: "0.5rem" }
    }, "Scan QR Code")
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
    return React.createElement("div", { className: "card" },
      React.createElement("h2", null, "QR Code Scanner"),
      React.createElement("p", { style: { color: "#ef4444" }}, error),
      React.createElement("button", { onClick: onClose, style: { marginTop: "1rem" }}, "Close")
    );
  }

  return React.createElement("div", { className: "card qr-scanner" },
    React.createElement("h2", null, "Scan a QR Code"),
    React.createElement("p", { style: { color: "#64748b", marginBottom: "1rem" }},
      "Point your camera at any QR code to see its contents."
    ),
    React.createElement("video", {
      ref: videoRef,
      style: { width: "100%", maxHeight: "350px", borderRadius: "8px", background: "#0f172a" },
      playsInline: true,
      autoPlay: true
    }),
    React.createElement("canvas", { ref: canvasRef, style: { display: "none" } }),
    React.createElement("button", { onClick: onClose, style: { marginTop: "1rem" }}, "Close")
  );
}
