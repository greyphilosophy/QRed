/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import { sealPdfInBrowser } from "./pdfClientSeal.js";
import { decodeSigningKey, deriveSigningPublicKey, generateSigningKeyPair, readSigningKeyFile, validateSigningKeyPair } from "./signingKeys.js";
import { encodeBase64Url } from "./sealSignature.js";
import { beginAccountSignIn, finishAccountSignIn, checkAccountSignInStatus, attestPagesWithAccount, accountSealingAvailable } from "./accountSealing.js";
import { AUTH_PROVIDERS, authProvider } from "./authProviders.js";
import { ProviderSignInButton } from "./ProviderSignInButton.jsx";

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
  const [privateKey, setPrivateKey] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [message, setMessage] = useState("");
  const [keyStatus, setKeyStatus] = useState("");
  const [keyError, setKeyError] = useState(false);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [pageScalingStrategy, setPageScalingStrategy] = useState("automatic");
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [readyForSignIn, setReadyForSignIn] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const [checkingAccount, setCheckingAccount] = useState(false);
  const [method, setMethod] = useState("private-key");
  const [signingIdentity, setSigningIdentity] = useState(null);
  const [availability, setAvailability] = useState(null);
  const [configError, setConfigError] = useState("");
  const [configAttempt, setConfigAttempt] = useState(0);
  const provider = authProvider(method);
  const usesAccount = Boolean(provider);
  const activeRequest = useRef(null);
  const pendingAccountSignIn = useRef(null);
  const derivedFor = useRef("");

  useEffect(() => {
    // Offline/private-key sealing must not depend on an authentication request.
    if (!usesAccount) return;
    let current = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    setConfigError("");
    setAvailability(null);
    fetch("/api/auth/config", { signal: controller.signal, credentials: "same-origin" })
      .then(async response => {
        if (!response.ok) throw new Error("Unavailable");
        const config = await response.json();
        if (!config || typeof config !== "object") throw new Error("Invalid configuration");
        if (!controller.signal.aborted) setAvailability(config);
      })
      .catch(() => { if (current) setConfigError("Could not check sign-in availability. Check your connection and retry, or use a private key file."); })
      .finally(() => clearTimeout(timer));
    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [usesAccount, configAttempt]);

  useEffect(() => () => {
    activeRequest.current?.controller.abort();
    const waiting = pendingAccountSignIn.current;
    pendingAccountSignIn.current = null;
    waiting?.reject(new Error("Account sealing cancelled"));
    try { activeRequest.current?.popup?.close(); } catch { /* The provider may isolate the popup. */ }
  }, []);

  useEffect(() => {
    let current = true;
    if (derivedFor.current === privateKey) return;
    derivedFor.current = "";
    setPublicKey("");
    if (privateKey.trim()) deriveSigningPublicKey(privateKey)
      .then(key => { if (current) { derivedFor.current = privateKey; setPublicKey(key); } }).catch(() => {});
    return () => { current = false; };
  }, [privateKey]);

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
      derivedFor.current = keys.privateKey;
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

  async function openKeyFile(event) {
    const input = event.currentTarget;
    const selectedFile = input.files?.[0];
    input.value = ""; // Allow choosing the same file again after an error/cancel.
    if (!selectedFile) return;
    setLoadingKeys(true);
    reportKeyStatus("Reading key file on this device...");
    try {
      const key = await readSigningKeyFile(selectedFile, "private");
      const matchingPublicKey = await deriveSigningPublicKey(key);
      const currentPrivateKey = privateKey.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      if (currentPrivateKey && currentPrivateKey !== key && !window.confirm("Replace the current signing keys with this private key? Save your current private key first if you want to reuse it.")) {
        reportKeyStatus("Key import cancelled. Current keys kept.");
        return;
      }
      derivedFor.current = key;
      setPrivateKey(key);
      setPublicKey(matchingPublicKey);
      setShowPrivateKey(false);
      reportKeyStatus("Private key opened. Matching public key derived. You can stamp a PDF now.");
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
      reportKeyStatus("Public key selected for verification on this device. You can now check your stamped seals above.");
    } catch (error) {
      reportKeyStatus(error.message, true);
    }
  }

  function cancelSealing() {
    activeRequest.current?.controller.abort();
    const waiting = pendingAccountSignIn.current;
    pendingAccountSignIn.current = null;
    waiting?.reject(new Error("Account sealing cancelled"));
    setReadyForSignIn(false);
    setAuthenticating(false);
  }

  async function checkSignInStatus() {
    const request = activeRequest.current;
    if (!request?.session || request.controller.signal.aborted) return;
    setCheckingAccount(true);
    try {
      const result = await checkAccountSignInStatus(request.provider, request.session,
        { signal: request.controller.signal });
      // Do not replace the finished PDF message with an older status response.
      if (activeRequest.current !== request) return;
      if (result.status === "ready") setMessage("Account sign-in verified by QRed. Finishing your PDF locally…");
      else if (result.status === "failed") setMessage("Account sign-in failed: " +
        (result.error || "The provider did not complete the request. Cancel and prepare the PDF again."));
      else setMessage("QRed has not received a completed sign-in from the provider. " +
        "If the Facebook tab closed, review any message it showed or cancel and prepare a new sign-in.");
    } catch (error) {
      if (activeRequest.current === request && !request.controller.signal.aborted)
        setMessage("Could not confirm account sign-in: " + error.message +
          " You can cancel and prepare the PDF again.");
    } finally {
      if (activeRequest.current === request) setCheckingAccount(false);
    }
  }

  async function sealPdf() {
    // Second, explicit user gesture: the PDF and its document-bound
    // authentication session are already prepared. Navigate directly to the
    // provider URL. There is no about:blank tab waiting for PDF processing.
    const waiting = pendingAccountSignIn.current;
    if (waiting) {
      if (waiting.provider !== method || Date.now() >= waiting.session.startedAt + 9 * 60 * 1000) {
        pendingAccountSignIn.current = null;
        setReadyForSignIn(false);
        waiting.reject(new Error("Sign-in preparation expired. Prepare the PDF again."));
        return;
      }
      const popup = window.open(waiting.session.authorize_url, "_blank", "popup,width=520,height=680");
      if (!popup) {
        setMessage("Your browser blocked the " + provider.label + " sign-in tab. Allow pop-ups for QRed, or open QRed in your browser and retry.");
        return;
      }
      if (activeRequest.current) activeRequest.current.popup = popup;
      pendingAccountSignIn.current = null;
      setReadyForSignIn(false);
      setAuthenticating(true);
      waiting.resolve(popup);
      return;
    }

    if (!file || (method === "private-key" && !privateKey.trim())) {
      setMessage("Choose a PDF and a sealing method. For local sealing, generate, open, or paste your private key.");
      return;
    }
    if (usesAccount && (!accountSealingAvailable || availability?.[method] !== true)) return;
    const controller = new AbortController();
    const request = { controller, popup: null };
    activeRequest.current = request;
    let saved = false;
    setLoading(true);
    setSigningIdentity(null);
    setReadyForSignIn(false);
    setAuthenticating(false);
    try {
      // Validate before parsing a PDF so key errors are immediate and actionable.
      const matchingPublicKey = method === "private-key" ? await deriveSigningPublicKey(privateKey) : null;
      if (matchingPublicKey) await validateSigningKeyPair({ privateKey, publicKey: matchingPublicKey });
      setMessage(usesAccount ? "Preparing your PDF locally before opening " + provider.label + "…" : "Sealing in this browser…");
      const { blob, sealResult, flattenedFieldCount, footerPages = [] } = await sealPdfInBrowser({
        file,
        ...(method === "private-key" ? { privateKey, publicKey: matchingPublicKey } : {
          attestPages: async pages => {
            const session = await beginAccountSignIn(method, pages, { signal: controller.signal });
            request.session = session; request.provider = method;
            let handedOff = false;
            try {
              if (controller.signal.aborted) throw new Error("Account sealing cancelled");
              const popup = await new Promise((resolve, reject) => {
                pendingAccountSignIn.current = { provider: method, session, resolve, reject };
                setReadyForSignIn(true);
                setMessage("PDF ready. Tap the " + provider.label + " sign-in button below. Once signed in, return to this QRed tab to finish sealing.");
              });
              handedOff = true;
              return await attestPagesWithAccount(method, pages, { popup, preparedSession: session,
                signal: controller.signal, onStatus: setMessage, onIdentity: setSigningIdentity });
            } finally {
              if (pendingAccountSignIn.current?.session === session) pendingAccountSignIn.current = null;
              setReadyForSignIn(false);
              if (!handedOff) await finishAccountSignIn(method, session);
            }
          },
        }),
        bootstrapUrl: BOOTSTRAP_URL,
        encodingStrategy: "automatic",
        pageScalingStrategy,
      });
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name.replace(/\.pdf$/i, "") + ".qred-sealed.pdf";
      link.click();
      saved = true;
      URL.revokeObjectURL(url);

      const IS_TEST = typeof window !== "undefined" && window.__qredTestMode === true;
      if (IS_TEST) window.__lastSealResult = sealResult;

      setMessage(
        [
          `Sealed ${file.name} in this browser.`,
          ...(footerPages.length ? [`Used clear footers on page(s) ${footerPages.join(", ")} to keep seals readable.`] : []),
          ...(flattenedFieldCount ? [`Flattened ${flattenedFieldCount} form field(s) before sealing.`] : []),
          `Selected encoding: ${sealResult.encoding}`,
          `Selected page scaling: ${pageScalingStrategy}`,
          `Estimated QR count: ${sealResult.estimated_qr_count || sealResult.total_seals || 0}`,
          `QR payload savings: ${sealResult.compression_savings_pct == null ? "not available" : `${sealResult.compression_savings_pct}%`}`,
          `Seal time: ${sealResult.timestamp}`,
          `Document ID: ${sealResult.document_id}`,
        ].join("\n")
      );
    } catch (error) {
      setMessage(controller.signal.aborted ? "Account sealing cancelled." : `PDF sealing failed: ${error.message}`);
    } finally {
      // If sign-in failed, leave the provider callback tab visible so its
      // sanitized error can be read. Never close it as a side effect of the
      // original document window reporting an error.
      if (saved || controller.signal.aborted) {
        try { request.popup?.close(); } catch { /* The provider may isolate the popup. */ }
      }
      if (activeRequest.current === request) activeRequest.current = null;
      setReadyForSignIn(false);
      setAuthenticating(false);
      setCheckingAccount(false);
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h2>Stamp a PDF</h2>
      <p style={{ color: "#64748b", marginBottom: "1rem" }}>
        Seal a PDF’s extracted text and use spare QR capacity for line locations and a small grayscale visual reference. Image-only pages receive a visual reference; blank pages receive a signed blank-page marker. Visual references are approximate and can lose small details, including digits and faces. Supported form fields are flattened before sealing. Review the values in your saved copy.
      </p>
      <p>Your PDF stays on your device. Stamping happens in this browser, and the file is not sent to a server.</p>
      <div className="demo-input">
        {loading
          ? <p className="sealing-method-selected">Sealing method: {method === "private-key" ? "Private key (offline)" : provider.label + " login"}</p>
          : <fieldset className="sealing-methods">
            <legend>Sealing method</legend>
            <p className="key-help">Choose how to seal your PDF. Account methods prepare the PDF locally before opening the login page.</p>
            <div className="sealing-method-grid">
              <button type="button" aria-pressed={method === "private-key"}
                onClick={() => { setMethod("private-key"); setMessage(""); setSigningIdentity(null); }}
                disabled={loadingKeys}>
                Private key (offline)
              </button>
              {Object.entries(AUTH_PROVIDERS).map(([id, account]) => <button
                key={id} type="button" aria-pressed={method === id}
                onClick={() => { setMethod(id); setMessage(""); setSigningIdentity(null); }}
                disabled={loadingKeys || !accountSealingAvailable || availability?.[id] === false}
                title={availability?.[id] === false ? "Not enabled on this QRed installation" : undefined}>
                {account.button}
              </button>)}
            </div>
          </fieldset>}
      </div>
      {usesAccount && <div className="signing-key-help">
        <p>{method === "google" ? "Use a Gmail or Google Workspace account. " : method === "microsoft" ? "Use a personal, work, or school Microsoft account. " : `Use your ${provider.label} account. `}
          After you choose a document, sign in to authorize QRed to attest its page contents, your account details, and the server time. Profile names are not independently verified identities.</p>
        {method !== "google" && <p>Your email is reported by {provider.label}; QRed does not separately verify control of that mailbox.</p>}
        <p>This method needs a connection for each document. Only randomized page fingerprints and account details reach QRed; {provider.label} receives the sign-in request. Your PDF, text, and private keys stay on this device. The finished seals can be verified offline.</p>
        <small>Your {provider.label} profile name and email will be readable by anyone who scans the seal.</small>
        {signingIdentity && <p>{provider.label} account: {signingIdentity.email}. Name: {signingIdentity.name} ({provider.label} profile).</p>}
        {configError ? <p role="status">{configError} <button type="button" onClick={() => setConfigAttempt(value => value + 1)}>Retry sign-in availability</button></p>
          : !availability ? <p role="status">Checking sign-in availability…</p>
            : availability[method] !== true && <p role="status">{provider.label} sealing is not enabled on this installation. Choose another sealing method.</p>}
      </div>}
      {method === "private-key" && <><details>
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
        <p>Save your private key to your device before closing this tool or reloading the page. QRed does not keep a copy. The saved file is unencrypted; keep it private. Open or paste a private key to reuse it; the matching public key is derived automatically.</p>
      </div>
      </>}
      <div className="demo-grid">
        <div className="demo-input">
          <label htmlFor="pdf-to-stamp">Open PDF</label>
          <input id="pdf-to-stamp" type="file" accept="application/pdf" disabled={loading} onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </div>
        {method === "private-key" && <div className="demo-input">
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
          <input id="signing-private-key-file" type="file" accept=".txt,text/plain" onChange={openKeyFile} disabled={loadingKeys || loading} />
          <div className="key-actions">
            <button type="button" onClick={() => setShowPrivateKey((v) => !v)}>
              {showPrivateKey ? "Hide private key" : "Show private key"}
            </button>
            <button type="button" onClick={() => saveKey("private")} disabled={!privateKey.trim() || loadingKeys || loading}>Save private key</button>
          </div>
          <small className="key-help">The public key is derived automatically. Share it through a trusted channel so recipients can verify local signatures.</small>
          <div className="key-actions">
            <button type="button" onClick={() => saveKey("public")} disabled={!publicKey.trim() || loadingKeys || loading}>Save public key</button>
            {onUsePublicKey && <button type="button" onClick={usePublicKey} disabled={!publicKey.trim() || loadingKeys || loading}>Use public key to verify</button>}
          </div>
        </div>}
        <div className="demo-input">
          <label>Page layout</label>
          <select
            aria-label="Page layout"
            value={pageScalingStrategy}
            disabled={loading}
            onChange={(e) => setPageScalingStrategy(e.target.value)}
            title="Choose where to place the document seals."
          >
            <option value="automatic">Automatic (watermark first, footer fallback)</option>
            <option value="watermark">Pale watermark (experimental, footer fallback)</option>
            <option value="legal-footer">Expand letter pages to legal size (bottom 3-inch footer)</option>
            <option value="shrink-footer">Shrink the document to create a footer</option>
          </select>
          <small style={{ color: "#64748b", display: "block", marginTop: "0.5rem" }}>
            {pageScalingStrategy === "automatic" || pageScalingStrategy === "watermark"
              ? "Tries pale watermarks first, analyzing each page to place seals around obstructing logos or pictures while keeping the original page size. Image-only pages, blank pages, and pages where a readable watermark cannot fit use a clear footer (legal size for letter pages; shrink otherwise). Use QRed's scanner and try a printed copy before sharing."
              : pageScalingStrategy === "legal-footer"
                ? "Adds a 3-inch footer below each page, preserving the original content size. Letter pages become legal size."
                : "Shrinks each page's content to make room for a clear footer, keeping the original paper size."}
          </small>
        </div>
      </div>
      <p id="signing-key-status" role="status" style={{ marginTop: "1rem", color: keyError ? "#ef4444" : "#64748b" }}>{keyStatus}</p>
      {usesAccount ? readyForSignIn
        ? <ProviderSignInButton provider={method} onClick={sealPdf}
          disabled={loadingKeys || !accountSealingAvailable || availability?.[method] !== true}
          aria-describedby="account-sealing-action" style={{ marginTop: "1rem" }} />
        : <button type="button" onClick={sealPdf}
          disabled={loading || loadingKeys || !accountSealingAvailable || availability?.[method] !== true}
          aria-busy={loading} style={{ marginTop: "1rem" }}>
          {loading ? (authenticating ? "Completing sign-in..." : "Preparing document...") : `Prepare PDF for ${provider.label} sign-in`}
        </button>
        : <button type="button" onClick={sealPdf} disabled={loading || loadingKeys} aria-busy={loading} style={{ marginTop: "1rem" }}>
          {loading ? "Sealing..." : "Stamp and save PDF"}
        </button>}
      {usesAccount && <p id="account-sealing-action" className="key-help">
        {readyForSignIn ? "Your PDF is prepared. Tap Authenticate to open the provider's login page directly. On a phone, return to this QRed tab afterward."
          : "First prepare your PDF on this device, then authenticate with your selected login. Your document is not sent to the provider."}
      </p>}
      {loading && usesAccount && authenticating && <button type="button"
        onClick={checkSignInStatus} disabled={checkingAccount}>
        {checkingAccount ? "Checking sign-in..." : "Check sign-in status"}
      </button>}
      {loading && usesAccount && <button type="button" onClick={cancelSealing}>Cancel sealing</button>}
      {message && (
        <p id="stamp-result" role="status" style={{ marginTop: "1rem", color: message.includes("failed") ? "#ef4444" : "#334155", whiteSpace: "pre-wrap" }}>
          {message}
        </p>
      )}
    </div>
  );
}
