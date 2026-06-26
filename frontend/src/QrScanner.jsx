import React, { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

/**
 * QrScanner — Camera-based QR code scanner that can scan ANY QR code and
 * display its contents. For QRED1? format codes, shows structured metadata.
 * For plain text, shows the raw content.
 */
export function QrScanner() {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const videoRef = useRef(null);

  // Display scan result
  if (result) {
    const data = parseQRedResult(result);
    return ScanResult({ data });
  }

  return ScannerView({ onScan: setResult });
}

function parseQRedResult(raw) {
  if (raw.startsWith("QRED1?")) {
    try {
      const params = new URLSearchParams(raw.slice(6));
      return {
        isQRed: true,
        text: params.get("txt") || "",
        issuer: params.get("iss") || "",
        documentId: params.get("doc") || "",
        keyId: params.get("kid") || "",
        timestamp: params.get("ts") || "",
        partIndex: params.get("i"),
        totalParts: params.get("n"),
      };
    } catch {
      return { isQRed: false, text: raw };
    }
  }
  return { isQRed: false, text: raw };
}

function ScanResult({ data }) {
  if (data.isQRed) {
    return React.createElement("div", { className: "card qr-scan-result" },
      React.createElement("h2", null, "QRed Document Data"),
      React.createElement("p", { style: { color: "#64748b", marginBottom: "1rem" }},
        React.createElement("span", null, "To verify the signature and bindings, open the "),
        React.createElement("a", { href: "/verify.htm" }, "QRed Verifier")
      ),
      React.createElement("div", { className: "doc-text" }, data.text),
      (data.issuer || data.documentId)
        ? React.createElement("div", { className: "fragment-meta" },
            data.issuer && React.createElement("div", { className: "meta-row" },
              React.createElement("span", { className: "meta-label" }, "Issuer:"),
              React.createElement("span", null, data.issuer)
            ),
            data.documentId && React.createElement("div", { className: "meta-row" },
              React.createElement("span", { className: "meta-label" }, "Document ID:"),
              React.createElement("span", null, data.documentId)
            )
          )
        : null,
      React.createElement("button", { onClick: () => window.location.hash = "", style: { marginTop: "1rem" } }, "New scan")
    );
  }
  // Plain text QR code
  return React.createElement("div", { className: "card qr-scan-result" },
    React.createElement("h2", null, "QR Code Content"),
    React.createElement("div", { className: "doc-text" }, data.text),
    React.createElement("button", { onClick: () => window.location.hash = "", style: { marginTop: "1rem" } }, "New scan")
  );
}

function ScannerView({ onScan }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [error, setError] = useState(null);
  const [active, setActive] = useState(true);

  useEffect(() => {
    let animId;
    let stream;
    const video = videoRef.current;

    function start() {
      if (!video) return;
      const constraints = { video: { facingMode: "environment" } };
      navigator.mediaDevices.getUserMedia(constraints).then(s => {
        stream = s;
        video.srcObject = s;
        video.play();
      }).catch(e => {
        setError("Camera access needed: " + (e.message || "facingMode: environment"));
        setActive(false);
      });
    }

    function stop() {
      if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
      }
      if (video && video.srcObject) {
        video.srcObject = null;
      }
      if (animId) cancelAnimationFrame(animId);
    }

    function scanFrame() {
      if (video && video.readyState === 4) {
        const canvas = canvasRef.current;
        if (canvas) {
          const ctx = canvas.getContext("2d");
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, canvas.width, canvas.height, { inverted: false });
          if (code && code.data) {
            onScan(code.data);
            stop();
            return;
          }
        }
      }
      animId = requestAnimationFrame(scanFrame);
    }

    start();

    return stop;
  }, []);

  if (!active) {
    return React.createElement("div", { className: "card" },
      React.createElement("h2", null, "QR Code Scanner"),
      error ? React.createElement("p", { style: { color: "#ef4444" }}, error)
            : React.createElement("p", null, "Scanner closed"),
      React.createElement("button", { onClick: () => window.location.hash = "" }, "Close")
    );
  }

  return React.createElement("div", { className: "card qr-scanner" },
    React.createElement("h2", null, "Scan a QR Code"),
    React.createElement("p", { style: { color: "#64748b", marginBottom: "1rem" }},
      "Point your camera at any QR code to see its contents."
    ),
    error ? React.createElement("p", { style: { color: "#ef4444" }}, error)
         : React.createElement("video", { ref: videoRef, style: { width: "100%", maxHeight: "350px", borderRadius: "8px", background: "#0f172a" }, playsInline: true, autoPlay: true }),
    React.createElement("canvas", { ref: canvasRef, style: { display: "none" } }),
    React.createElement("button", { onClick: () => { setActive(false); stop(); } }, "Close")
  );
}
