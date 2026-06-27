import React, { useEffect, useState } from "react";
import { sealPdfInBrowser } from "./pdfClientSeal.js";
import { QrScanner } from "./QrScanner.jsx";
import { FragmentDisplay } from "./FragmentDisplay.jsx";

function normalizeApiBase(value) {
  const trimmed = (value || "/api").trim();
  const withoutTrailingSlash = trimmed.replace(/\/+$/, "");
  return withoutTrailingSlash || "/api";
}

const API_BASE = normalizeApiBase(import.meta.env.VITE_API_BASE_URL);

async function responseErrorMessage(response) {
  const text = await response.text();
  if (!text) return `${response.status} ${response.statusText}`.trim();

  try {
    const data = JSON.parse(text);
    return data.message || data.error || text;
  } catch {
    return text;
  }
}

function isMissingBackendOriginMessage(message) {
  return message.includes("API-backed demo endpoints require a separate QRed backend origin")
    || message.includes("QRED_API_ORIGIN is not configured");
}

function VerifierFrame() {
  return React.createElement("section", { className: "card verifier-card" },
    React.createElement("div", { className: "verifier-card-header" },
      React.createElement("h2", null, "QRed Verifier"),
      React.createElement("a", { href: "/verify.htm", target: "_blank", rel: "noreferrer" }, "Open full verifier")
    ),
    React.createElement("p", { style: { color: "#64748b", marginBottom: "1rem" }},
      "Scan QR seals, add manual seal text, and verify documents with the same verifier served at qred.org/verify.htm."),
    React.createElement("iframe", {
      title: "QRed Verifier",
      src: "/verify.htm",
      className: "verifier-frame",
    })
  );
}

function PdfSealForm() {
  const [file, setFile] = useState(null);
  const [issuer, setIssuer] = useState("QRed Demo Authority");
  const [privateKey, setPrivateKey] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [message, setMessage] = useState("");
  const [keyStatus, setKeyStatus] = useState("Loading default keys...");
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [encodingStrategy, setEncodingStrategy] = useState("automatic");
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [loading, setLoading] = useState(false);

  async function loadDefaultKeys() {
    setLoadingKeys(true);
    setKeyStatus("Loading default keys...");

    try {
      const response = await fetch(API_BASE + "/keys/default");
      if (!response.ok) throw new Error(await responseErrorMessage(response));
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
    } catch (error) {
      setKeyStatus(`Default key loading failed: ${error.message}`);
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
    setMessage("Stamping QRed seals onto each PDF page...");
    const form = new FormData();
    form.append("file", file);
    form.append("issuer", issuer);
    form.append("private_key", privateKey);
    form.append("public_key", publicKey);
    form.append("bootstrap_url", "https://qred.org/");
    form.append("encoding_strategy", encodingStrategy);

    try {
      const response = await fetch(API_BASE + "/pdf/upload-seal", { method: "POST", body: form });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name.replace(/\.pdf$/i, "") + ".qred-sealed.pdf";
      link.click();
      URL.revokeObjectURL(url);
      setMessage([
        `Selected encoding: ${response.headers.get("X-QRed-Encoding") || "plaintext"}`,
        `Selected recipe: ${response.headers.get("X-QRed-Selected-Recipe") || "plaintext"}`,
        `Estimated QR count: ${response.headers.get("X-QRed-Estimated-QR-Count") || response.headers.get("X-QRed-Total-Seals") || "0"}`,
        `Compression savings: ${response.headers.get("X-QRed-Compression-Savings-Pct") || "0"}%`,
        `Document ID: ${response.headers.get("X-QRed-Document-Id")}`,
      ].join("\n"));
    } catch (error) {
      if (!isMissingBackendOriginMessage(error.message)) {
        setMessage(`PDF sealing failed: ${error.message}`);
        return;
      }

      try {
        setMessage("Backend PDF sealing is not configured; sealing in this browser instead...");
        const { blob, sealResult } = await sealPdfInBrowser({
          file,
          issuer,
          privateKey,
          publicKey,
          bootstrapUrl: "https://qred.org/",
          encodingStrategy,
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = file.name.replace(/\.pdf$/i, "") + ".qred-sealed.pdf";
        link.click();
        URL.revokeObjectURL(url);
        setMessage([
          `Selected encoding: ${sealResult.encoding}`,
          `Selected recipe: ${sealResult.selected_recipe || "plaintext"}`,
          `Estimated QR count: ${sealResult.estimated_qr_count || sealResult.total_seals}`,
          `Compression savings: ${sealResult.compression_savings_pct || 0}%`,
          `Document ID: ${sealResult.document_id}`,
        ].join("\n"));
      } catch (fallbackError) {
        setMessage(`PDF sealing failed: ${fallbackError.message}`);
      }
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
          React.createElement("option", { value: "simple_english" }, "Recipe 1 – Simple English"),
          React.createElement("option", { value: "legacy_compression" }, "Legacy Compression")
        ),
        React.createElement("small", { style: { color: "#64748b", display: "block", marginTop: "0.5rem" } },
          "Automatic tries every reversible recipe and chooses the smallest successful encoding."
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
  return React.createElement("div", { className: "container" },
    React.createElement("h1", null, "QRed"),
    React.createElement("p", { className: "subtitle" }, "Tamper-evident QR seals for paper documents"),
    React.createElement(FragmentDisplay),
    React.createElement(QrScanner),
    React.createElement(VerifierFrame),
    React.createElement(PdfSealForm),
    React.createElement("p", { className: "footer" },
      "QR payload target: https://qred.org/#data")
  );
}

export default App;
