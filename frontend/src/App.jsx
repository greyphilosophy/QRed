import React, { useState, useRef, useEffect, useCallback } from "react";
import jsQR from "jsqr";

// ── QR Scanner Component ─────────────────────────────────────────────────

function QrScanner({ onScan, scannedCount, totalExpected }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState(null);

  const isScanning = useRef(false);
  const lastScanTime = useRef(0);
  const animFrameRef = useRef(null);

  // Debounce: don't report scans closer than 500ms to avoid duplicates
  const SCAN_DEBOUNCE_MS = 500;

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setCameraActive(true);
        isScanning.current = true;
        startScanning();
      }
    } catch (err) {
      setCameraError(err.message || "Camera access needed!");
    }
  };

  const startScanning = () => {
    const scan = () => {
      if (!isScanning.current || !videoRef.current || !canvasRef.current) return;

      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        const code = jsQR(imageData.data, canvas.width, canvas.height);
        if (code && code.data.startsWith("QRED")) {
          // Debounce: avoid reporting the same code multiple times
          const now = Date.now();
          if (now - lastScanTime.current >= SCAN_DEBOUNCE_MS) {
            onScan(code.data);
            lastScanTime.current = now;
            navigator.vibrate?.(100);
          }
        }
      }

      // Continue the scan loop
      animFrameRef.current = requestAnimationFrame(scan);
    };
    animFrameRef.current = requestAnimationFrame(scan);
  };

  const stopCamera = () => {
    isScanning.current = false;
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isScanning.current = false;
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  // Progress bar
  const progressPct = totalExpected > 0 ? Math.round((scannedCount / totalExpected) * 100) : 0;

  return React.createElement("div", null,
    React.createElement("h2", { style: { marginBottom: "1rem", textAlign: "center" }}, "📷 Scan QRed Seals"),
    React.createElement("p", { style: { textAlign: "center", color: "#64748b", marginBottom: "1rem" }},
      scannedCount > 0
        ? `${scannedCount} chunk${scannedCount !== 1 ? 's' : ''} scanned${totalExpected > 0 ? ` (${scannedCount}/${totalExpected})` : ''}`
        : "Point your camera at the QR codes..."
    ),

    // Progress bar
    totalExpected > 0 ? React.createElement("div", {
      style: { background: "#e2e8f0", borderRadius: "999px", height: "8px", width: "100%", marginBottom: "1rem", overflow: "hidden" }
    },
      React.createElement("div", {
        style: {
          background: "#10b981",
          height: "100%",
          width: `${progressPct}%`,
          transition: "width 0.3s",
          borderRadius: "999px",
        }
      })
    ) : null,

    // Camera viewfinder
    React.createElement("div", {
      style: {
        position: "relative",
        width: "100%",
        maxWidth: "400px",
        aspectRatio: "4/3",
        margin: "0 auto",
        overflow: "hidden",
        borderRadius: "12px",
        background: "#1e293b",
      }
    },
      React.createElement("video", {
        ref: videoRef,
        playsInline: true,
        muted: true,
        style: { width: "100%", height: "100%", objectFit: "cover" }
      }),
      React.createElement("canvas", { ref: canvasRef, style: { display: "none" } }),
      !cameraActive && React.createElement("div", {
        style: {
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          color: "#94a3b0",
          fontSize: "1.5rem",
          textAlign: "center",
        }
      }, "📸 Camera view")
    ),

    cameraError && React.createElement("p", { style: { color: "#ef4444", marginTop: "1rem", textAlign: "center" }}, cameraError),

    cameraActive
      ? React.createElement("button", {
          onClick: stopCamera,
          style: { marginTop: "1rem", background: "#ef4444", color: "white", border: "none", padding: "0.75rem 1.5rem", borderRadius: "8px", cursor: "pointer", fontSize: "1rem", fontWeight: 600 }
        }, "Stop Camera")
      : React.createElement("button", {
          onClick: startCamera,
          style: { marginTop: "1rem", background: "#3b82f6", color: "white", border: "none", padding: "0.75rem 1.5rem", borderRadius: "8px", cursor: "pointer", fontSize: "1rem", fontWeight: 600 }
        }, "Start Camera")
  );
}

// ── Result Display ───────────────────────────────────────────────────────

function renderResult(result) {
  if (result.status === "SELF_SIGNED") {
    return React.createElement("div", {
      style: {
        background: "#fffbeb",
        border: "1px solid #f59e0b",
        borderRadius: "8px",
        padding: "1.5rem",
      }
    },
      React.createElement("span", {
        style: {
          display: "inline-block",
          padding: "0.25rem 0.75rem",
          borderRadius: "999px",
          fontSize: "0.85rem",
          fontWeight: 600,
          background: "#f59e0b",
          color: "white",
          marginBottom: "0.5rem",
        }
      }, "SELF_SIGNED (Integrity Verified)"),
      React.createElement("p", { style: { color: "#d97706", fontSize: "0.8rem", marginBottom: "1rem" }},
        "⚠️ " + (result.warning || "Issuer identity is self-signed — compare the embedded public key fingerprint against a trusted registry for full authenticity")),
      React.createElement("p", { style: { marginBottom: "0.5rem" }},
        React.createElement("strong", null, "Issuer: "), result.issuer),
      React.createElement("p", { style: { marginBottom: "0.5rem" }},
        React.createElement("strong", null, "Document ID: "), result.document_id),
      React.createElement("p", { style: { marginBottom: "0.5rem" }},
        React.createElement("strong", null, "Timestamp: "), new Date(result.timestamp).toLocaleString()),
      React.createElement("div", {
        style: { background: "#f1f5f9", borderRadius: "8px", padding: "1rem", marginTop: "1rem", whiteSpace: "pre-wrap", fontSize: "0.9rem" }
      }, result.content)
    );
  }
  if (result.status === "SELF_SIGNED_INVALID") {
    return React.createElement("div", {
      style: {
        background: "#fef2f2",
        border: "1px solid #ef4444",
        borderRadius: "8px",
        padding: "1.5rem",
      }
    },
      React.createElement("span", {
        style: {
          display: "inline-block",
          padding: "0.25rem 0.75rem",
          borderRadius: "999px",
          fontSize: "0.85rem",
          fontWeight: 600,
          background: "#ef4444",
          color: "white",
          marginBottom: "1rem",
        }
      }, "SELF_SIGNED_INVALID"),
      React.createElement("p", { style: { color: "#d97706", fontSize: "0.8rem", marginBottom: "1rem" }},
        "Content was reconstructed but the embedded signature did not match the embedded public key.")
    );
  }
  // INCOMPLETE or ERROR
  return React.createElement("div", {
    style: {
      background: result.status === "INCOMPLETE" ? "#fffbeb" : "#fef2f2",
      border: `1px solid ${result.status === "INCOMPLETE" ? "#f59e0b" : "#ef4444"}`,
      borderRadius: "8px",
      padding: "1.5rem",
    }
  },
    React.createElement("span", {
      style: {
        display: "inline-block",
        padding: "0.25rem 0.75rem",
        borderRadius: "999px",
        fontSize: "0.85rem",
        fontWeight: 600,
        background: result.status === "INCOMPLETE" ? "#f59e0b" : "#ef4444",
        color: "white",
        marginBottom: "1rem",
      }
    }, result.status),
    React.createElement("p", null, result.error_message || "Verification failed")
  );
}

// ── Main App ─────────────────────────────────────────────────────────────

function App() {
  const [mode, setMode] = useState("scan");
  const [sealInput, setSealInput] = useState("");
  const [verificationResult, setVerificationResult] = useState(null);
  const [error, setError] = useState(null);

  // Chunk tracking: Map<docId, Map<chunkNum, sealString>>
  const [chunks, setChunks] = useState(new Map());
  const [totalExpected, setTotalExpected] = useState(0);

  function handleScannedSeal(sealStr) {
    const parts = sealStr.split("|");
    if (parts.length < 5) return;

    const docId = parts[1];
    const chunkNum = parts[2];
    const totalStr = parts[3];
    const total = parseInt(totalStr, 10);

    if (total > 0) {
      setTotalExpected(total);
    }

    setChunks(prev => {
      const next = new Map(prev);
      if (!next.has(docId)) {
        next.set(docId, new Map());
      }
      const docChunks = next.get(docId);
      if (!docChunks.has(chunkNum)) {
        docChunks.set(chunkNum, sealStr);
        return next;
      }
      return prev;
    });
  }

  function getAllSeals() {
    const seals = [];
    for (const [docId, docChunks] of chunks) {
      for (const seal of docChunks.values()) {
        seals.push(seal);
      }
    }
    return seals;
  }

  function getTotalScanned() {
    let count = 0;
    for (const [docId, docChunks] of chunks) {
      count += docChunks.size;
    }
    return count;
  }

  function hasCompleteDocument() {
    for (const [docId, docChunks] of chunks) {
      if (docChunks.size >= totalExpected && totalExpected > 0) {
        return docId;
      }
    }
    return null;
  }

  async function verifySeals(seals) {
    try {
      setError(null);
      const resp = await fetch("/api/verify/self-contained", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seals }),
      });
      const data = await resp.json();

      if (data.status === "SELF_SIGNED") {
        setVerificationResult({
          status: "SELF_SIGNED",
          warning: data.warning,
          issuer: data.issuer,
          document_id: data.document_id,
          timestamp: data.timestamp,
          content: data.content,
        });
      } else if (data.status === "SELF_SIGNED_INVALID") {
        setVerificationResult({
          status: "SELF_SIGNED_INVALID",
          warning: null,
        });
      } else {
        setVerificationResult({
          status: data.status,
          error_message: data.error_message || "Verification failed",
        });
      }
    } catch (err) {
      setError(err.message);
    }
  }

  function handleTextVerify() {
    const seals = sealInput.trim().split("\n").map(s => s.trim()).filter(s => s.length > 0);
    if (seals.length > 0) {
      verifySeals(seals);
    }
  }

  function clearAll() {
    setChunks(new Map());
    setTotalExpected(0);
    setVerificationResult(null);
    setError(null);
  }

  const scannedCount = getTotalScanned();

  return React.createElement("div", { style: { fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif", maxWidth: "600px", margin: "0 auto", padding: "2rem 1rem" }},
    React.createElement("h1", { style: { textAlign: "center", marginBottom: "0.5rem", fontSize: "2rem" }}, "QRed"),
    React.createElement("p", { style: { textAlign: "center", color: "#64748b", marginBottom: "2rem" }},
      "Tamper-evident document verification"),

    // Mode tabs
    React.createElement("div", { style: { display: "flex", gap: "0.5rem", marginBottom: "2rem" }},
      React.createElement("button", {
        onClick: () => setMode("scan"),
        style: {
          flex: 1,
          padding: "0.75rem",
          borderRadius: "8px",
          border: "none",
          background: mode === "scan" ? "#3b82f6" : "#e2e8f0",
          color: mode === "scan" ? "white" : "#64748b",
          cursor: "pointer",
          fontWeight: 600,
        }
      }, "📷 Scan"),
      React.createElement("button", {
        onClick: () => setMode("text"),
        style: {
          flex: 1,
          padding: "0.75rem",
          borderRadius: "8px",
          border: "none",
          background: mode === "text" ? "#3b82f6" : "#e2e8f0",
          color: mode === "text" ? "white" : "#64748b",
          cursor: "pointer",
          fontWeight: 600,
        }
      }, "📝 Paste")
    ),

    // Scanner mode
    mode === "scan" && React.createElement(QrScanner, {
      onScan: handleScannedSeal,
      scannedCount: scannedCount,
      totalExpected: totalExpected,
    }),

    // Text mode
    mode === "text" && React.createElement("div", { style: { background: "white", borderRadius: "12px", padding: "1.5rem", marginBottom: "1.5rem", boxShadow: "0 1px 3px rgba(0,0,0,0.1)" }},
      React.createElement("h2", { style: { marginBottom: "1rem" }}, "Paste QRed Seals"),
      React.createElement("textarea", {
        value: sealInput,
        onChange: (e) => setSealInput(e.target.value),
        placeholder: "Paste QRed seal strings here...\nOne per line.",
        style: { width: "100%", minHeight: "120px", border: "2px solid #e2e8f0", borderRadius: "8px", padding: "0.75rem", fontFamily: "monospace", fontSize: "0.9rem", resize: "vertical", marginBottom: "1rem" }
      }),
      React.createElement("button", {
        onClick: handleTextVerify,
        style: { background: "#3b82f6", color: "white", border: "none", padding: "0.75rem 1.5rem", borderRadius: "8px", cursor: "pointer", fontSize: "1rem", fontWeight: 600 }
      }, "Verify")
    ),

    // Scan status
    scannedCount > 0 && React.createElement("div", {
      style: { background: "#f1f5f9", borderRadius: "8px", padding: "1rem", marginBottom: "1rem" }
    },
      React.createElement("p", null, `${scannedCount} seal${scannedCount !== 1 ? 's' : ''} scanned`),
      totalExpected > 0 ? React.createElement("p", { style: { color: scannedCount >= totalExpected ? "#10b981" : "#f59e0b" }},
        scannedCount >= totalExpected
          ? "✓ All chunks collected"
          : `${scannedCount} / ${totalExpected} chunks`
      ) : null,
      React.createElement("button", {
        onClick: clearAll,
        style: { marginTop: "0.5rem", background: "#e2e8f0", color: "#64748b", border: "none", padding: "0.5rem 1rem", borderRadius: "8px", cursor: "pointer", fontSize: "0.85rem" }
      }, "Clear Scans")
    ),

    // Verification result
    verificationResult ? renderResult(verificationResult) : null,
    error && React.createElement("p", { style: { color: "#ef4444", textAlign: "center" }}, error),

    React.createElement("p", { style: { textAlign: "center", marginTop: "2rem", fontSize: "0.85rem", color: "#64748b" }},
      "Powered by QRed · Ed25519")
  );
}

export default App;
