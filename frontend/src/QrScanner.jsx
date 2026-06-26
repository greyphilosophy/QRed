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

  // Display scan result — show ANY QR code content (plaintext, URL, QRED1?)
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
          onClick: () => { setMode("idle"); setScannedText(null); },
          style: { marginTop: "1rem" }
        }, "New scan")
      );
    }
    // Plain text / URL / other QR content
    return React.createElement("div", { className: "card qr-scan-result" },
      React.createElement("h2", null, "QR Code Content"),
      React.createElement("div", { className: "doc-text" }, scannedText),
      React.createElement("button", {
        onClick: () => { setMode("idle"); setScannedText(null); },
        style: { marginTop: "1rem" }
      }, "New scan")
    );
  }

  // Scanning mode
  if (mode === "scanning") {
    return ScannerView();
  }

  // Default — user-initiated start
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

/**
 * ScannerView — Camera capture + jsQR loop. Uses the onQRFound ref to pass
 * scan results back to QrScanner without closure capture issues.
 */
function ScannerView() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [error, setError] = useState(null);
  const [closed, setClosed] = useState(false);

  // This ref holds the callback that the scan loop calls when a QR is found.
  // We update it here so it always points to the latest version.
  const onQRFoundRef = useRef(null);
  onQRFoundRef.current = (text) => {
    setMode("result");
    setScannedText(text);
  };

  useEffect(() => {
    let animId;
    let stream;

    function stop() {
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
      }
      const video = videoRef.current;
      if (video && video.srcObject) {
        video.srcObject = null;
      }
      if (animId) cancelAnimationFrame(animId);
    }

    function scanFrame() {
      const video = videoRef.current;
      if (video && video.readyState === 4) {
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext("2d");
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, canvas.width, canvas.height, { inverted: false });
          if (code && code.data) {
            stop();
            onQRFoundRef.current(code.data);
            return;
          }
        }
      }
      animId = requestAnimationFrame(scanFrame);
    }

    const constraints = { video: { facingMode: "environment" } };
    navigator.mediaDevices.getUserMedia(constraints)
      .then(s => {
        stream = s;
        const video = videoRef.current;
        video.srcObject = s;
        video.play();
        scanFrame();
      })
      .catch(e => {
        setError("Camera access needed: " + (e.message || "facingMode: environment"));
        stop();
      });

    return stop;
  }, []);

  if (error) {
    return React.createElement("div", { className: "card" },
      React.createElement("h2", null, "QR Code Scanner"),
      React.createElement("p", { style: { color: "#ef4444" }}, error),
      React.createElement("button", { onClick: () => setClosed(true), style: { marginTop: "1rem" }}, "Close")
    );
  }

  if (closed) {
    return null;
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
    React.createElement("button", { onClick: () => setClosed(true), style: { marginTop: "1rem" }}, "Close")
  );
}
