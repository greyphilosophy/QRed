import React, { useEffect, useState } from "react";
import { sealPdfInBrowser } from "./pdfClientSeal.js";
import { QrScanner } from "./QrScanner.jsx";

function PdfSealForm() {
  const [file, setFile] = useState(null);
  const [issuer, setIssuer] = useState("QRed Demo Authority");
  const [privateKey, setPrivateKey] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [message, setMessage] = useState("");
  const [keyStatus, setKeyStatus] = useState("Loading default keys...");
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [encodingStrategy, setEncodingStrategy] = useState("automatic");
  const [pageScalingStrategy, setPageScalingStrategy] = useState("automatic");
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [loading, setLoading] = useState(false);

  async function loadDefaultKeys() {
    setLoadingKeys(true);
    setKeyStatus("Loading default keys...");

    try {
      const response = await fetch("/api/keys/default");
      if (!response.ok) throw new Error((await response.text()) || `${response.status} ${response.statusText}`.trim());
      const keys = await response.json();
      setPrivateKey(keys.private_key);
      setPublicKey(keys.public_key);
      if (keys.source === "environment" || keys.source === "worker-environment") {
        setKeyStatus("Default keys loaded from server environment.");
      } else if (keys.source === "worker-static-demo") {
        setKeyStatus("Static demo keys loaded from qred.org. Configure QRED_DEFAULT_PRIVATE_KEY, QRED_DEFAULT_PUBLIC_KEY, and QRED_DEFAULT_KEY_ID on the Worker to use stable custom defaults.");
      } else {
        setKeyStatus("Ephemeral demo keys loaded. Set QRED_DEFAULT_PRIVATE_KEY and QRED_DEFAULT_PUBLIC_KEY on the API server to use stable defaults.");
      }
    } catch {
      setPrivateKey("txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=");
      setPublicKey("eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=");
      setKeyStatus("Static demo keys loaded from the bundled fallback, because /api/keys/default was unavailable.");
    } finally {
      setLoadingKeys(false);
    }
  }

  useEffect(() => {
    if (!privateKey || !publicKey) {
      loadDefaultKeys();
    }
  }, []);

  async function sealPdf() {
    if (!file || !issuer || !privateKey || !publicKey) {
      setMessage("Choose a PDF and provide issuer keys before sealing.");
      return;
    }
    setLoading(true);
    try {
      setMessage("Sealing in this browser...");
      const { blob, sealResult } = await sealPdfInBrowser({
        file,
        issuer,
        privateKey,
        publicKey,
        bootstrapUrl: "https://qred.org/",
        encodingStrategy,
        pageScalingStrategy,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name.replace(/\.pdf$/i, "") + ".qred-sealed.pdf";
      link.click();
      URL.revokeObjectURL(url);
      setMessage([
        `Sealed ${file.name} in this browser. Document ID: ${sealResult.document_id}`,
        `Selected encoding: ${sealResult.encoding || encodingStrategy}`,
        `Selected page scaling: ${pageScalingStrategy}`,
        `Selected recipe: ${sealResult.selected_recipe || "plaintext"}`,
        `Estimated QR count: ${sealResult.estimated_qr_count || sealResult.total_seals || 0}`,
        `Compression savings: ${sealResult.compression_savings_pct || 0}%`,
        `Document ID: ${sealResult.document_id}`,
      ].join("\n"));
    } catch (error) {
      setMessage(`PDF sealing failed: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  return React.createElement("div", { className: "card" },
    React.createElement("h2", null, "Demo: Upload and Seal a PDF"),
    React.createElement("p", { style: { color: "#64748b", marginBottom: "1rem" }},
      "Select a PDF, stamp every page with a verifier QR plus payload QR seals, and download the sealed copy."),
    React.createElement("div", { className: "demo-grid" },
      React.createElement("div", { className: "demo-input" },
        React.createElement("label", null, "PDF file"),
        React.createElement("input", { "aria-label": "PDF file", type: "file", accept: "application/pdf", onChange: (e) => setFile(e.target.files?.[0] || null) })
      ),
      React.createElement("div", { className: "demo-input" },
        React.createElement("label", null, "Issuer"),
        React.createElement("input", { "aria-label": "Issuer", value: issuer, onChange: (e) => setIssuer(e.target.value) })
      ),
      React.createElement("div", { className: "demo-input" },
        React.createElement("label", null, "Private Key"),
        React.createElement("input", { "aria-label": "Private Key", type: showPrivateKey ? "text" : "password", value: privateKey, onChange: (e) => setPrivateKey(e.target.value), placeholder: "Default private key", autoComplete: "off" }),
        React.createElement("button", { type: "button", onClick: () => setShowPrivateKey((value) => !value), style: { marginTop: "0.5rem" }}, showPrivateKey ? "Hide private key" : "Show private key")
      ),
      React.createElement("div", { className: "demo-input" },
        React.createElement("label", null, "Public Key"),
        React.createElement("input", { "aria-label": "Public Key", value: publicKey, onChange: (e) => setPublicKey(e.target.value), placeholder: "Default public key" })
      ),
      React.createElement("div", { className: "demo-input" },
        React.createElement("label", null, "Encoding Strategy"),
        React.createElement("select", { "aria-label": "Encoding Strategy", value: encodingStrategy, onChange: (e) => setEncodingStrategy(e.target.value), title: "Automatic tries every reversible recipe and chooses the smallest successful encoding." },
          React.createElement("option", { value: "automatic" }, "Automatic (recommended)"),
          React.createElement("option", { value: "plaintext" }, "Plaintext"),
          React.createElement("option", { value: "b45" }, "Recipe 1 – b45"),
          React.createElement("option", { value: "brotli" }, "Brotli (when smaller)")
        ),
        React.createElement("small", { style: { color: "#64748b", display: "block", marginTop: "0.5rem" } },
          "Automatic tries every reversible recipe and chooses the smallest successful encoding."
        )
      ),
      React.createElement("div", { className: "demo-input" },
        React.createElement("label", null, "Page scaling"),
        React.createElement("select", { "aria-label": "Page scaling", value: pageScalingStrategy, onChange: (e) => setPageScalingStrategy(e.target.value), title: "Choose how the PDF should make room for QR seals before drawing the footer." },
          React.createElement("option", { value: "automatic" }, "Automatic (legal for letter, shrink otherwise)"),
          React.createElement("option", { value: "legal-footer" }, "Expand letter pages to legal size (bottom 3-inch footer)"),
          React.createElement("option", { value: "shrink-footer" }, "Shrink the document to create a footer")
        ),
        React.createElement("small", { style: { color: "#64748b", display: "block", marginTop: "0.5rem" } },
          "Automatic expands letter pages to legal size and keeps seals in the bottom 3 inches; other page sizes shrink to create room for the seals."
        )
      )
    ),
    React.createElement("p", { style: { marginTop: "1rem", color: keyStatus.includes("failed") ? "#ef4444" : "#64748b" }}, keyStatus),
    React.createElement("button", { onClick: loadDefaultKeys, disabled: loadingKeys, style: { marginRight: "1rem", marginTop: "1rem" }}, loadingKeys ? "Loading Default Keys..." : "Use Default Keys"),
    React.createElement("button", { onClick: sealPdf, disabled: loading || loadingKeys, style: { marginTop: "1rem" }}, loading ? "Sealing..." : "Upload PDF and Stamp QR Seals"),
    message && React.createElement("p", { style: { marginTop: "1rem", color: message.includes("failed") ? "#ef4444" : "#334155" }}, message)
  );
}

function App() {
  const [showPdfStampTool, setShowPdfStampTool] = useState(false);

  return React.createElement("main", { className: "homepage" },
    React.createElement(QrScanner, { onOpenPdfStampTool: () => setShowPdfStampTool(true) }),
    showPdfStampTool && React.createElement("section", { className: "pdf-stamp-tool", id: "pdf-stamp-tool" },
      React.createElement("div", { className: "tool-header" },
        React.createElement("div", null,
          React.createElement("p", { className: "eyebrow" }, "PDF stamping tool"),
          React.createElement("h2", null, "Stamp a PDF with QRed seals")
        ),
        React.createElement("button", { className: "tool-close", onClick: () => setShowPdfStampTool(false), type: "button" }, "Close")
      ),
      React.createElement(PdfSealForm)
    )
  );
}

export default App;
