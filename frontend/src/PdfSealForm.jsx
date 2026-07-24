/* eslint-disable no-unused-vars */
import React, { useEffect, useState } from "react";
import { sealPdfInBrowser } from "./pdfClientSeal.js";

const BUNDLED_PUBLIC_KEY = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";
const BOOTSTRAP_URL = "https://qred.org/";

export function PdfSealForm() {
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

  // Keep legacy global for Python E2E harness compatibility
  useEffect(() => {
    if (typeof window !== "undefined") window.__qredPublicKeys = publicKey;
  }, [publicKey]);

  async function loadDefaultKeys() {
    setLoadingKeys(true);
    setKeyStatus("Loading default public key...");

    try {
      const response = await fetch("/api/keys/default");
      if (!response.ok) throw new Error((await response.text()) || `${response.status} ${response.statusText}`.trim());
      const keys = await response.json();
      setPublicKey(keys.public_key);
      setKeyStatus(
        privateKey
          ? "Public key loaded. Ready to seal with your private key."
          : "Public key loaded. Please enter your private key before sealing. (The server does not store private keys.)"
      );
    } catch {
      setPublicKey(BUNDLED_PUBLIC_KEY);
      setKeyStatus(
        privateKey
          ? "Public key loaded from bundled fallback. Ready to seal with your private key."
          : "Public key loaded from bundled fallback. Please enter your private key before sealing."
      );
    } finally {
      setLoadingKeys(false);
    }
  }

  useEffect(() => {
    if (!privateKey || !publicKey) loadDefaultKeys();
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
        bootstrapUrl: BOOTSTRAP_URL,
        encodingStrategy,
        pageScalingStrategy,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name.replace(/\.pdf$/i, "") + ".qred-sealed.pdf";
      link.click();
      URL.revokeObjectURL(url);

      const IS_TEST = typeof window !== "undefined" && window.__qredTestMode === true;
      if (IS_TEST) window.__lastSealResult = sealResult;

      setMessage(
        [
          `Sealed ${file.name} in this browser. Document ID: ${sealResult.document_id}`,
          `Selected encoding: ${sealResult.encoding || encodingStrategy}`,
          `Selected page scaling: ${pageScalingStrategy}`,
          `Selected recipe: ${sealResult.selected_recipe || "plaintext"}`,
          `Estimated QR count: ${sealResult.estimated_qr_count || sealResult.total_seals || 0}`,
          `Compression savings: ${sealResult.compression_savings_pct || 0}%`,
          `Document ID: ${sealResult.document_id}`,
        ].join("\n")
      );
    } catch (error) {
      setMessage(`PDF sealing failed: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h2>Demo: Upload and Seal a PDF</h2>
      <p style={{ color: "#64748b", marginBottom: "1rem" }}>
        Select a PDF, stamp every page with a verifier QR plus payload QR seals, and download the sealed copy.
      </p>
      <div className="demo-grid">
        <div className="demo-input">
          <label>PDF file</label>
          <input aria-label="PDF file" type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </div>
        <div className="demo-input">
          <label>Issuer</label>
          <input aria-label="Issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)} />
        </div>
        <div className="demo-input">
          <label>Private Key</label>
          <input
            aria-label="Private Key"
            type={showPrivateKey ? "text" : "password"}
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
            placeholder="Default private key"
            autoComplete="off"
          />
          <button type="button" onClick={() => setShowPrivateKey((v) => !v)} style={{ marginTop: "0.5rem" }}>
            {showPrivateKey ? "Hide private key" : "Show private key"}
          </button>
        </div>
        <div className="demo-input">
          <label>Public Key</label>
          <input aria-label="Public Key" value={publicKey} onChange={(e) => setPublicKey(e.target.value)} placeholder="Default public key" />
        </div>
        <div className="demo-input">
          <label>Encoding Strategy</label>
          <select
            aria-label="Encoding Strategy"
            value={encodingStrategy}
            onChange={(e) => setEncodingStrategy(e.target.value)}
            title="Automatic tries every reversible recipe and chooses the smallest successful encoding."
          >
            <option value="automatic">Automatic (recommended)</option>
            <option value="plaintext">Plaintext</option>
            <option value="b45">Recipe 1 – b45</option>
            <option value="brotli">Brotli (when smaller)</option>
          </select>
          <small style={{ color: "#64748b", display: "block", marginTop: "0.5rem" }}>
            Automatic tries every reversible recipe and chooses the smallest successful encoding.
          </small>
        </div>
        <div className="demo-input">
          <label>Page scaling</label>
          <select
            aria-label="Page scaling"
            value={pageScalingStrategy}
            onChange={(e) => setPageScalingStrategy(e.target.value)}
            title="Choose how the PDF should make room for QR seals before drawing the footer."
          >
            <option value="automatic">Automatic (legal for letter, shrink otherwise)</option>
            <option value="legal-footer">Expand letter pages to legal size (bottom 3-inch footer)</option>
            <option value="shrink-footer">Shrink the document to create a footer</option>
          </select>
          <small style={{ color: "#64748b", display: "block", marginTop: "0.5rem" }}>
            Automatic expands letter pages to legal size and keeps seals in the bottom 3 inches; other page sizes shrink to create room for the seals.
          </small>
        </div>
      </div>
      <p style={{ marginTop: "1rem", color: keyStatus.includes("failed") ? "#ef4444" : "#64748b" }}>{keyStatus}</p>
      <button onClick={loadDefaultKeys} disabled={loadingKeys} style={{ marginRight: "1rem", marginTop: "1rem" }}>
        {loadingKeys ? "Loading Default Keys..." : "Use Default Keys"}
      </button>
      <button onClick={sealPdf} disabled={loading || loadingKeys} style={{ marginTop: "1rem" }}>
        {loading ? "Sealing..." : "Upload PDF and Stamp QR Seals"}
      </button>
      {message && (
        <p style={{ marginTop: "1rem", color: message.includes("failed") ? "#ef4444" : "#334155", whiteSpace: "pre-wrap" }}>
          {message}
        </p>
      )}
    </div>
  );
}
