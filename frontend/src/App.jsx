import React, { useState, useRef, useEffect, useCallback } from "react";

// In-browser Ed25519 verification using the @noble/ed25519 library
// This eliminates the backend round-trip for mobile verification

// ── Minimal in-browser Ed25519 verifier ──────────────────────────────────
// Uses the payload's embedded public_key (no registry lookup needed)

function base64urlDecode(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob(b64 + pad), c => c.charCodeAt(0));
}

function base64urlEncode(bytes) {
  const bin = String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// SHA-256 (Web Crypto API)
async function sha256(msg) {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(msg));
  return new Uint8Array(hash);
}

// Ed25519 verification using the noble-ed25519 library
// We load it as a module from CDN for the mobile scanner
let Ed25519Module = null;

async function loadEd25519() {
  if (Ed25519Module) return Ed25519Module;
  const mod = await import("https://esm.sh/@noble/curves@2.2.4/ed25519");
  Ed25519Module = mod;
  return mod;
}

async function verifyEd25519(content, signature_b64, pubkey_b64) {
  const ed = await loadEd25519();
  const sig = base64urlDecode(signature_b64);
  const pub = base64urlDecode(pubkey_b64);
  try {
    return await ed.ed25519.verify(sig, content, pub);
  } catch {
    return false;
  }
}

// ── QR Scanner Component ─────────────────────────────────────────────────

const QR_CAMERA_ID = "qr-scanner";

function QrScanner({ onScan, collectedChunks, totalChunks }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const animFrameRef = useRef(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const [scannedCount, setScannedCount] = useState(0);
  const [isScanning, setIsScanning] = useState(false);
  const [lastScanned, setLastScanned] = useState(null);

  // JsQR reference
  let JsQR = null;
  const loadJsQR = async () => {
    if (JsQR) return JsQR;
    const mod = await import("https://esm.sh/jsqr@1.4.0");
    JsQR = mod.default || mod;
    return mod;
  };

  const startCamera = async () => {
    try {
      setIsScanning(true);
      const jsqr = await loadJsQR();

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setCameraReady(true);

        // Start scanning loop
        const scan = () => {
          if (!videoRef.current || !canvasRef.current) return;
          const video = videoRef.current;
          const canvas = canvasRef.current;

          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsqr(imageData.data, canvas.width, canvas.height);

            if (code && code.data.startsWith("QRED")) {
              onScan(code.data);
              setLastScanned(code.data);
              // Brief pause to avoid scanning the same code repeatedly
              setIsScanning(false);
              setTimeout(() => setIsScanning(true), 800);
              return;
            }
          }
          animFrameRef.current = requestAnimationFrame(scan);
        };
        animFrameRef.current = requestAnimationFrame(scan);
      }
    } catch (err) {
      setCameraError(err.message || "Camera access needed!");
      setIsScanning(false);
    }
  };

  const stopCamera = () => {
    setIsScanning(false);
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
    }
    setCameraReady(false);
  };

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  // Calculate progress
  const progressPct = totalChunks > 0 ? Math.round((scannedCount / totalChunks) * 100) : 0;

  const handleScanResult = useCallback((sealStr) => {
    // Extract chunk info
    const parts = sealStr.split("|", 5);
    if (parts.length >= 5) {
      const docId = parts[1];
      const chunkNum = parseInt(parts[2]);
      const total = parseInt(parts[3]);
      setScannedCount(prev => Math.min(prev + 1, total));
      // Vibrate feedback
      navigator.vibrate?.(100);
    }
  }, []);

  return React.createElement("div", { style: { textAlign: "center" } },
    React.createElement("h2", { style: { marginBottom: "1rem" }}, "📷 Scan QRed Seals"),
    React.createElement("p", { style: { color: "#64748b", marginBottom: "1rem" }},
      collectedChunks > 0 ? `${collectedChunks} chunk${collectedChunks !== 1 ? 's' : ''} scanned` : "Point your camera at the QR codes..."),

    // Progress indicator
    totalChunks > 0 ? React.createElement("div", {
      style: { background: "#e2e8f0", borderRadius: "999px", height: "8px", width: "100%", marginBottom: "1rem", overflow: "hidden" }
    },
      React.createElement("div", {
        style: {
          background: "#10b981",
          height: "100%",
          width: `${(scannedCount / totalChunks) * 100}%`,
          transition: "width 0.3s",
          borderRadius: "999px",
        },
      })
    ) : null,

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
        autoplay: false,
        style: { width: "100%", height: "100%", objectFit: "cover" }
      }),
      React.createElement("canvas", { ref: canvasRef, style: { display: "none" } }),
      !cameraReady && React.createElement("div", {
        style: {
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          color: "#94a3b0",
          fontSize: "1.5rem",
        }
      }, "📸 Camera view")
    ),

    cameraError && React.createElement("p", { style: { color: "#ef4444", marginTop: "1rem" }}, cameraError),

    React.createElement("button", {
      onClick: startCamera,
      disabled: isScanning || cameraReady,
      style: { marginTop: "1rem", opacity: cameraReady ? 0.7 : 1 }
    },
      isScanning ? "🔍 Scanning..." : cameraReady ? "Camera Active" : "Start Camera"
    ),

    cameraReady && React.createElement("button", {
      onClick: stopCamera,
      style: { marginTop: "1rem", marginLeft: "1rem" }
    }, "Stop Camera")
  );
}

// ── Main App ─────────────────────────────────────────────────────────────

function App() {
  const [mode, setMode] = useState("scan"); // scan, text, generate
  const [scannedChunks, setScannedChunks] = useState(new Map());
  const [sealInput, setSealInput] = useState("");
  const [result, setResult] = useState(null);
  const [verificationStatus, setVerificationStatus] = useState(null);
  const [totalExpected, setTotalExpected] = useState(0);

  function handleScannedSeal(sealStr) {
    const parts = sealStr.split("|", 5);
    if (parts.length < 5) return;
    const [, docId, chunkNumStr, totalStr] = parts;
    const chunkNum = parseInt(chunkNumStr);
    const total = parseInt(totalStr);
    setTotalExpected(total);

    setScannedChunks(prev => {
      const next = new Map(prev);
      if (next.has(docId)) {
        next.get(docId).set(chunkNumStr, sealStr);
      } else {
        next.set(docId, new Map([[chunkNumStr, sealStr]]));
      }
      return next;
    });
  }

  function processAllScans() {
    const allSeals = [];
    for (const [, chunks] of scannedChunks) {
      for (const seal of chunks.values()) {
        allSeals.push(seal);
      }
    }
    if (allSeals.length > 0) {
      // In-browser verification
      verifyInBrowser(allSeals);
    }
  }

  async function verifyInBrowser(seals) {
    try {
      const decoded = [];
      for (const seal of seals) {
        const parts = seal.split("|", 5);
        if (parts.length >= 5 && parts[0].startsWith("QRED")) {
          decoded.push({
            chunkNum: parseInt(parts[2]),
            total: parseInt(parts[3]),
            data: parts[4],
            docId: parts[1],
          });
        }
      }

      // Check completeness
      const totalChunks = decoded[0]?.total;
      const received = new Set(decoded.map(d => d.chunkNum));
      const expected = new Set(Array.from({ length: totalChunks }, (_, i) => i));
      const missing = [...expected].filter(i => !received.has(i));

      if (missing.length > 0) {
        setVerificationStatus("incomplete");
        setResult({
          status: "INCOMPLETE",
          error_message: `Missing chunks: ${missing.join(", ")} (${decoded.length}/${totalChunks} scanned)`,
        });
        return;
      }

      // Reconstruct payload
      const ordered = Array.from({ length: totalChunks }).map((_, i) => {
        const chunk = decoded.find(d => d.chunkNum === i);
        return chunk.data;
      });
      const rawData = ordered.join("");

      // Decompress
      const compressed = base64urlDecode(rawData);
      const payloadJson = await new Response(new Blob([compressed]), {
        headers: { "Content-Type": "application/gzip" }
      }).arrayBuffer().then(buf => {
        const stream = new Response(buf).body.getReader();
        return new Promise((resolve, reject) => {
          // Use Pako or browser decompression
          const dt = new DecompressionStream("gzip");
          const reader = new Response(new Blob([compressed]).stream()).body
            .pipeThrough(dt).getReader();
          let result = "";
          function read() {
            reader.read().then(({ done, value }) => {
              if (done) { resolve(result); return; }
              result += new TextDecoder().decode(value);
              read();
            }).catch(reject);
          }
          read();
        });
      });

      const payload = JSON.parse(payloadJson);

      // Verify Ed25519 signature in-browser
      const content = payload.content;
      const sig = payload.signature;
      const pubkey = payload.public_key;

      const isValid = await verifyEd25519(content, sig, pubkey);
      setVerificationStatus(isValid ? "valid" : "invalid");
      setResult({
        status: isValid ? "VALID" : "INVALID",
        issuer: payload.issuer,
        document_id: payload.document_id,
        timestamp: payload.timestamp,
        content: content,
        error_message: isValid ? "" : "Digital signature verification failed",
      });
    } catch (err) {
      setVerificationStatus("error");
      setResult({
        status: "ERROR",
        error_message: err.message || "Decompression failed",
      });
    }
  }

  // ── UI ─────────────────────────────────────────────────────────────────

  const renderScanStatus = () => {
    if (scannedChunks.size === 0) return null;
    let totalScanned = 0;
    let totalExpectedAny = 0;
    for (const [, chunks] of scannedChunks) {
      totalScanned += chunks.size;
      if (!totalExpectedAny) {
        // Get total from first chunk
        const first = chunks.values().next().value;
        if (first) {
          const parts = first.split("|");
          totalExpectedAny = parseInt(parts[4]);
        }
      }
    }
    return React.createElement("div", {
      style: {
        background: "#f1f5f9",
        borderRadius: "8px",
        padding: "1rem",
        marginBottom: "1rem",
      }
    },
      React.createElement("p", null, `${totalScanned} seal${totalScanned !== 1 ? 's' : ''} scanned`),
      totalExpectedAny > 0 ? React.createElement("p", { style: { color: totalScanned >= totalExpectedAny ? "#10b981" : "#f59e0b" }},
        totalScanned >= totalExpectedAny
          ? "✓ All chunks collected!"
          : `${totalScanned} / ${totalExpectedAny} chunks — tap Verify to check`,
      ) : null,
      React.createElement("button", {
        onClick: processAllScans,
        style: { marginTop: "0.5rem", background: "#10b981" }
      }, "Verify Document")
    );
  };

  return React.createElement("div", { style: { fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif", maxWidth: "600px", margin: "0 auto", padding: "2rem 1rem", background: "#f8fafc", minHeight: "100vh", color: "#1e293b" }},
    React.createElement("h1", { style: { textAlign: "center", marginBottom: "0.5rem", fontSize: "2rem" }}, "QRed"),
    React.createElement("p", { style: { textAlign: "center", color: "#64748b", marginBottom: "2rem" }},
      "Tamper-evident document sealing & verification"),

    // Mode tabs
    React.createElement("div", { style: { display: "flex", gap: "0.5rem", marginBottom: "2rem" }},
      ["scan", "text", "generate"].map(m =>
        React.createElement("button", {
          key: m,
          onClick: () => setMode(m),
          style: {
            flex: 1,
            padding: "0.75rem",
            borderRadius: "8px",
            border: "none",
            background: mode === m ? "#3b82f6" : "#e2e8f0",
            color: mode === m ? "white" : "#64748b",
            cursor: "pointer",
            fontWeight: 600,
            textTransform: "capitalize",
          }
        }, m === "scan" ? "📷 Scan" : m === "text" ? "📝 Paste" : "✨ Generate")
      )
    ),

    mode === "scan" && React.createElement(QrScanner, {
      onScan: handleScannedSeal,
      collectedChunks: scannedChunks.size,
      totalChunks: totalExpected,
    }),

    renderScanStatus(),

    mode === "text" && React.createElement("div", { style: { background: "white", borderRadius: "12px", padding: "1.5rem", marginBottom: "1.5rem", boxShadow: "0 1px 3px rgba(0,0,0,0.1)" }},
      React.createElement("h2", { style: { marginBottom: "1rem" }}, "Paste QRed Seals"),
      React.createElement("textarea", {
        value: sealInput,
        onChange: (e) => setSealInput(e.target.value),
        placeholder: "Paste QRed seal strings here...\nOne per line.",
        style: { width: "100%", minHeight: "120px", border: "2px solid #e2e8f0", borderRadius: "8px", padding: "0.75rem", fontFamily: "monospace", fontSize: "0.9rem", resize: "vertical", marginBottom: "1rem" }
      }),
      React.createElement("button", {
        onClick: () => {
          const seals = sealInput.trim().split("\n").map(s => s.trim()).filter(s => s.length > 0);
          if (seals.length > 0) {
            verifyInBrowser(seals);
          }
        },
        style: { background: "#3b82f6", color: "white", border: "none", padding: "0.75rem 1.5rem", borderRadius: "8px", cursor: "pointer", fontSize: "1rem", fontWeight: 600 }
      }, "Verify")
    ),

    // Verification result
    result ? React.createElement("div", {
      style: {
        background: result.status === "VALID" ? "#ecfdf5" : result.status === "INCOMPLETE" ? "#fffbeb" : "#fef2f2",
        border: `1px solid ${result.status === "VALID" ? "#10b981" : result.status === "INCOMPLETE" ? "#f59e0b" : "#ef4444"}`,
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
          background: result.status === "VALID" ? "#10b981" : result.status === "INCOMPLETE" ? "#f59e0b" : "#ef4444",
          color: "white",
          marginBottom: "1rem",
        }
      }, result.status),
      result.status === "VALID" ? React.createElement(React.Fragment, null,
        React.createElement("p", { style: { marginBottom: "0.5rem" }},
          React.createElement("strong", null, "Issuer: "), result.issuer),
        React.createElement("p", { style: { marginBottom: "0.5rem" }},
          React.createElement("strong", null, "Document ID: "), result.document_id),
        React.createElement("p", { style: { marginBottom: "0.5rem" }},
          React.createElement("strong", null, "Timestamp: "), new Date(result.timestamp).toLocaleString()),
        React.createElement("div", {
          style: { background: "#f1f5f9", borderRadius: "8px", padding: "1rem", marginTop: "1rem", whiteSpace: "pre-wrap", fontSize: "0.9rem" }
        }, result.content)
      ) : React.createElement("p", null, result.error_message || "Verification failed")
    ) : null,

    React.createElement("p", { style: { textAlign: "center", marginTop: "2rem", fontSize: "0.85rem", color: "#64748b" }},
      "Powered by QRed · Ed25519 · Self-contained verification")
  );
}

export default App;
