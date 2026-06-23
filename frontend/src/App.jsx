import React, { useEffect, useState } from "react";
import { sealPdfInBrowser } from "./pdfClientSeal.js";
import { extractSealsFromFragment, verifyQRedSeals } from "./qredVerifier.js";

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

function VerifyForm() {
  const [sealInput, setSealInput] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fragmentSeals = extractSealsFromFragment(window.location.hash);
    if (fragmentSeals.length > 0) {
      setSealInput(fragmentSeals.join("\n"));
    }
  }, []);

  function handleSubmit() {
    const seals = sealInput.trim().split("\n").map(s => s.trim()).filter(s => s.length > 0);
    if (seals.length > 0) {
      verify(seals);
    }
  }

  function verify(seals) {
    setLoading(true);
    setError(null);
    verifyQRedSeals(seals, publicKey)
      .then((data) => {
        setResult(data);
        setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }

  function renderResult() {
    if (!result) return null;
    if (result.status === "VALID") {
      return React.createElement("div", { style: { background: "#ecfdf5", border: "1px solid #10b981", borderRadius: "8px", padding: "1.5rem" } },
        React.createElement("span", { style: { display: "inline-block", padding: "0.25rem 0.75rem", borderRadius: "999px", fontSize: "0.85rem", fontWeight: 600, background: "#10b981", color: "white", marginBottom: "1rem" }}, "VALID"),
        React.createElement("p", { style: { marginBottom: "0.5rem" }},
          React.createElement("strong", null, "Issuer: "), result.issuer),
        React.createElement("p", { style: { marginBottom: "0.5rem" }},
          React.createElement("strong", null, "Document ID: "), result.document_id),
        React.createElement("p", { style: { marginBottom: "0.5rem" }},
          React.createElement("strong", null, "Timestamp: "), new Date(result.timestamp).toLocaleString()),
        React.createElement("div", { style: { background: "#f1f5f9", borderRadius: "8px", padding: "1rem", marginTop: "1rem", whiteSpace: "pre-wrap" }}, result.content)
      );
    }
    if (result.status === "INCOMPLETE") {
      return React.createElement("div", { style: { background: "#fffbeb", border: "1px solid #f59e0b", borderRadius: "8px", padding: "1.5rem" }},
        React.createElement("span", { style: { display: "inline-block", padding: "0.25rem 0.75rem", borderRadius: "999px", fontSize: "0.85rem", fontWeight: 600, background: "#f59e0b", color: "white", marginBottom: "1rem" }}, "INCOMPLETE"),
        React.createElement("p", null, result.error_message)
      );
    }
    return React.createElement("div", { style: { background: "#fef2f2", border: "1px solid #ef4444", borderRadius: "8px", padding: "1.5rem" }},
      React.createElement("span", { style: { display: "inline-block", padding: "0.25rem 0.75rem", borderRadius: "999px", fontSize: "0.85rem", fontWeight: 600, background: "#ef4444", color: "white", marginBottom: "1rem" }}, result.status),
      React.createElement("p", null, result.error_message || "Verification failed")
    );
  }

  return React.createElement("div", { className: "card" },
    React.createElement("h2", null, "Verify QRed Document"),
    React.createElement("p", { style: { color: "#64748b", marginBottom: "1rem" }},
      "Enter QRed seal strings (one per line) to verify a document:"),
    React.createElement("textarea", {
      value: sealInput,
      onChange: (e) => setSealInput(e.target.value),
      placeholder: "Paste QRed seal strings here...\nOne per line.",
    }),
    React.createElement("label", null, "Issuer Public Key"),
    React.createElement("input", {
      value: publicKey,
      onChange: (e) => setPublicKey(e.target.value),
      placeholder: "Paste the issuer public key used to verify the signature",
      style: { width: "100%", marginBottom: "1rem" },
    }),
    React.createElement("button", { onClick: handleSubmit, disabled: loading },
      loading ? "Verifying..." : "Verify Document"),
    error && React.createElement("p", { style: { color: "#ef4444", marginTop: "1rem" }}, error),
    renderResult()
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
      setMessage(`Sealed ${file.name}. Document ID: ${response.headers.get("X-QRed-Document-Id")}`);
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
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = file.name.replace(/\.pdf$/i, "") + ".qred-sealed.pdf";
        link.click();
        URL.revokeObjectURL(url);
        setMessage(`Sealed ${file.name} in this browser. Document ID: ${sealResult.document_id}`);
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
    React.createElement(VerifyForm),
    React.createElement(PdfSealForm),
    React.createElement("p", { className: "footer" },
      "QR payload target: https://qred.org/#data")
  );
}

export default App;
