/* eslint-disable no-unused-vars */
import React, { useEffect, useState } from "react";
import { sealPdfInBrowser } from "./pdfClientSeal.js";
import { decodeSigningKey, deriveSigningPublicKey, generateSigningKeyPair, readSigningKeyFile, validateSigningKeyPair } from "./signingKeys.js";
import { encodeBase64Url } from "./sealSignature.js";

const BOOTSTRAP_URL = "https://qred.org/";

function saveText(text, filename) {
  const url = URL.createObjectURL(new Blob([text + "\n"], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Allow browsers to start the download before releasing its URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PdfSealForm({ onUsePublicKey }) {
  const [file, setFile] = useState(null);
  const [issuer, setIssuer] = useState("QRed Demo Authority");
  const [privateKey, setPrivateKey] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [message, setMessage] = useState("");
  const [keyStatus, setKeyStatus] = useState("");
  const [keyError, setKeyError] = useState(false);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [encodingStrategy, setEncodingStrategy] = useState("automatic");
  const [pageScalingStrategy, setPageScalingStrategy] = useState("automatic");
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [loading, setLoading] = useState(false);

  // Keep legacy global for Python E2E harness compatibility
  useEffect(() => {
    if (typeof window !== "undefined") window.__qredPublicKeys = publicKey;
  }, [publicKey]);

  function reportKeyStatus(text, error = false) {
    setKeyStatus(text);
    setKeyError(error);
  }

  async function generateKeys() {
    if ((privateKey || publicKey) && !window.confirm("Replace the current keys with a new pair? Save your private key first if you want to reuse it.")) return;
    setLoadingKeys(true);
    reportKeyStatus("Generating an Ed25519 key pair in this browser...");
    try {
      const keys = await generateSigningKeyPair();
      setPrivateKey(keys.privateKey);
      setPublicKey(keys.publicKey);
      setShowPrivateKey(false);
      reportKeyStatus("Key pair generated. You can stamp a PDF now. Save your private key to reuse this signing identity later.");
    } catch (error) {
      reportKeyStatus(`Key generation failed: ${error.message}`, true);
    } finally {
      setLoadingKeys(false);
    }
  }

  async function derivePublicKey() {
    setLoadingKeys(true);
    try {
      setPublicKey(await deriveSigningPublicKey(privateKey));
      reportKeyStatus("Matching public key derived from your private key.");
    } catch (error) {
      reportKeyStatus(error.message, true);
    } finally {
      setLoadingKeys(false);
    }
  }

  async function openKeyFile(event, kind) {
    const input = event.currentTarget;
    const selectedFile = input.files?.[0];
    input.value = ""; // Allow choosing the same file again after an error/cancel.
    if (!selectedFile) return;
    setLoadingKeys(true);
    reportKeyStatus("Reading key file on this device...");
    try {
      const key = await readSigningKeyFile(selectedFile, kind);
      if (kind === "private") {
        const matchingPublicKey = await deriveSigningPublicKey(key);
        const currentPrivateKey = privateKey.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        if (currentPrivateKey && currentPrivateKey !== key && !window.confirm("Replace the current signing keys with this private key? Save your current private key first if you want to reuse it.")) {
          reportKeyStatus("Key import cancelled. Current keys kept.");
          return;
        }
        setPrivateKey(key);
        setPublicKey(matchingPublicKey);
        setShowPrivateKey(false);
        reportKeyStatus("Private key opened. Matching public key derived. You can stamp a PDF now.");
      } else {
        if (privateKey.trim()) await validateSigningKeyPair({ privateKey, publicKey: key });
        setPublicKey(key);
        reportKeyStatus("Public key opened from your device.");
      }
    } catch (error) {
      reportKeyStatus(`Key import failed: ${error.message}`, true);
    } finally {
      setLoadingKeys(false);
    }
  }

  function saveKey(kind) {
    try {
      const key = encodeBase64Url(decodeSigningKey(kind === "private" ? privateKey : publicKey, kind));
      saveText(key, `qred-ed25519-${kind}-key.txt`);
      reportKeyStatus(kind === "private"
        ? "Private key ready to save to your device. This file is unencrypted: keep it private and store it securely."
        : "Public key ready to save to your device. Share this key with anyone who needs to verify your seals.");
    } catch (error) {
      reportKeyStatus(error.message, true);
    }
  }

  function usePublicKey() {
    try {
      const key = encodeBase64Url(decodeSigningKey(publicKey, "public"));
      onUsePublicKey(key);
      reportKeyStatus('Public key copied to "Verify collected seals" above. You can now check your stamped seals there.');
    } catch (error) {
      reportKeyStatus(error.message, true);
    }
  }

  async function sealPdf() {
    if (!file || !issuer.trim() || !privateKey.trim() || !publicKey.trim()) {
      setMessage("Choose a PDF, enter an issuer, and generate, open, or paste your Ed25519 keys before sealing.");
      return;
    }
    setLoading(true);
    try {
      // Validate before parsing a PDF so key errors are immediate and actionable.
      await validateSigningKeyPair({ privateKey, publicKey });
      setMessage("Sealing in this browser...");
      const { blob, sealResult, flattenedFieldCount } = await sealPdfInBrowser({
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
          ...(flattenedFieldCount ? [`Flattened ${flattenedFieldCount} form field(s) before sealing.`] : []),
          `Selected encoding: ${sealResult.encoding || encodingStrategy}`,
          `Selected page scaling: ${pageScalingStrategy}`,
          `Estimated QR count: ${sealResult.estimated_qr_count || sealResult.total_seals || 0}`,
          `QR payload savings: ${sealResult.compression_savings_pct == null ? "not available" : `${sealResult.compression_savings_pct}%`}`,
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
      <h2>Stamp a PDF</h2>
      <p style={{ color: "#64748b", marginBottom: "1rem" }}>
        Open a PDF from your device, seal the readable text on every page, and save the stamped copy. Supported form fields are automatically flattened before their text is signed. Images, handwriting, checkbox marks, and page appearance are not authenticated. Scanned or blank pages require a checked text layer before sealing. Review the values in your saved copy.
      </p>
      <p>Your PDF stays on your device. Stamping happens in this browser, and the file is not sent to a server.</p>
      <details>
        <summary>Optional: use airplane mode</summary>
        <p>Load QRed, then enable airplane mode and turn Wi-Fi and Bluetooth off in your device settings to limit network access while you work. Keep this tab open.</p>
        <p>Try your workflow with a non-sensitive file before opening sensitive documents. Some PDF fonts and text-recognition resources may still need an internet connection.</p>
      </details>
      <div className="signing-key-help">
        <h3>Signing keys</h3>
        <p>New to QRed? Generate an Ed25519 key pair below. The private key signs your PDFs; the public key lets others verify them. Keys are generated or opened in this browser and are never sent to a server.</p>
        <button type="button" onClick={generateKeys} disabled={loadingKeys || loading}>
          {loadingKeys ? "Preparing keys..." : "Generate key pair"}
        </button>
        <p>Save your private key to your device before closing this tool or reloading the page. QRed does not keep a copy. The saved file is unencrypted; keep it private. To reuse it, choose Open private key file; the matching public key is filled automatically. You can also paste a private key and choose Derive public key.</p>
      </div>
      <div className="demo-grid">
        <div className="demo-input">
          <label htmlFor="pdf-to-stamp">Open PDF</label>
          <input id="pdf-to-stamp" type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </div>
        <div className="demo-input">
          <label>Issuer</label>
          <input aria-label="Issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)} />
        </div>
        <div className="demo-input">
          <label htmlFor="signing-private-key">Private Key</label>
          <input
            id="signing-private-key"
            aria-label="Private Key"
            aria-describedby="private-key-help"
            type={showPrivateKey ? "text" : "password"}
            value={privateKey}
            onChange={(e) => { setPrivateKey(e.target.value); reportKeyStatus(""); }}
            placeholder="Generate, open, or paste an Ed25519 private key"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={loadingKeys || loading}
          />
          <small id="private-key-help" className="key-help">Keep secret. Raw 32-byte Ed25519 seed, encoded as Base64URL or Base64 (43 characters, optionally followed by =). PEM, SSH, and hex keys are not accepted.</small>
          <label htmlFor="signing-private-key-file">Open private key file</label>
          <input id="signing-private-key-file" type="file" accept=".txt,text/plain" onChange={(event) => openKeyFile(event, "private")} disabled={loadingKeys || loading} />
          <div className="key-actions">
            <button type="button" onClick={() => setShowPrivateKey((v) => !v)}>
              {showPrivateKey ? "Hide private key" : "Show private key"}
            </button>
            <button type="button" onClick={() => saveKey("private")} disabled={!privateKey.trim() || loadingKeys || loading}>Save private key</button>
            <button type="button" onClick={derivePublicKey} disabled={!privateKey.trim() || loadingKeys || loading}>Derive public key</button>
          </div>
        </div>
        <div className="demo-input">
          <label htmlFor="signing-public-key">Public Key</label>
          <input id="signing-public-key" aria-label="Public Key" aria-describedby="public-key-help" value={publicKey}
            onChange={(e) => { setPublicKey(e.target.value); reportKeyStatus(""); }}
            placeholder="Generated with your private key" autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={loadingKeys || loading} />
          <small id="public-key-help" className="key-help">Safe to share. Raw 32-byte Ed25519 public key in Base64URL or Base64. Give it to recipients through a trusted channel so they can verify your seals.</small>
          <label htmlFor="signing-public-key-file">Open public key file</label>
          <input id="signing-public-key-file" type="file" accept=".txt,text/plain" onChange={(event) => openKeyFile(event, "public")} disabled={loadingKeys || loading} />
          <div className="key-actions">
            <button type="button" onClick={() => saveKey("public")} disabled={!publicKey.trim() || loadingKeys || loading}>Save public key</button>
            {onUsePublicKey && <button type="button" onClick={usePublicKey} disabled={!publicKey.trim() || loadingKeys || loading}>Use public key to verify</button>}
          </div>
        </div>
        <div className="demo-input">
          <label>Encoding Strategy</label>
          <select
            aria-label="Encoding Strategy"
            value={encodingStrategy}
            onChange={(e) => setEncodingStrategy(e.target.value)}
            title="Automatic chooses plaintext or gzip to use fewer QR codes, then fewer bytes."
          >
            <option value="automatic">Automatic (recommended)</option>
            <option value="plaintext">Plaintext</option>
            <option value="gzip">Gzip</option>
          </select>
          <small style={{ color: "#64748b", display: "block", marginTop: "0.5rem" }}>
            Automatic chooses plaintext or gzip to use fewer QR codes, then fewer bytes.
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
      <p id="signing-key-status" role="status" style={{ marginTop: "1rem", color: keyError ? "#ef4444" : "#64748b" }}>{keyStatus}</p>
      <button onClick={sealPdf} disabled={loading || loadingKeys} style={{ marginTop: "1rem" }}>
        {loading ? "Sealing..." : "Stamp and save PDF"}
      </button>
      {message && (
        <p id="stamp-result" role="status" style={{ marginTop: "1rem", color: message.includes("failed") ? "#ef4444" : "#334155", whiteSpace: "pre-wrap" }}>
          {message}
        </p>
      )}
    </div>
  );
}
