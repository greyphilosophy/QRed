/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import { sealPdfInBrowser } from "./pdfClientSeal.js";
import { decodeSigningKey, deriveSigningPublicKey, generateSigningKeyPair, readSigningKeyFile, validateSigningKeyPair } from "./signingKeys.js";
import { encodeBase64Url } from "./sealSignature.js";
import { beginAccountSignIn, finishAccountSignIn, checkAccountSignInStatus, attestPagesWithAccount, completeAccountSignIn, accountSealingAvailable } from "./accountSealing.js";
import { AUTH_PROVIDERS, authProvider } from "./authProviders.js";
import { ProviderSdkButtons } from "./ProviderSdkButtons.jsx";
import { createSdkNonce, loadMicrosoftSdk, loadAmazonSdk, prepareMicrosoft, prepareAmazon, microsoftPopup, amazonPopup } from "./providerSdkAuth.js";
import { openAmazonSignInTab } from "./amazonSignInTab.js";
import { ACCOUNT_SESSION_SECONDS } from "./accountAuthLimits.js";

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
  // Keep the verified authorization href stable across the link's click.
  // Clearing a ref in onClick must not remove href before native navigation.
  const [preparedAuthorizeUrl, setPreparedAuthorizeUrl] = useState("");
  const [authenticating, setAuthenticating] = useState(false);
  const [checkingAccount, setCheckingAccount] = useState(false);
  const [method, setMethod] = useState(null);
  const [loginNonce, setLoginNonce] = useState(() => createSdkNonce());
  const [sdkClientIds, setSdkClientIds] = useState(null);
  const [sdkReady, setSdkReady] = useState({ microsoft: false, amazon: false });
  const microsoftApp = useRef(null);
  const googlePending = useRef(null);
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

  useEffect(() => {
    // Only load third-party login libraries after the user has selected a PDF
    // for account signing. Offline/private-key mode remains fully local.
    if (!file || method === "private-key") return;
    let current = true;
    const controller = new AbortController();
    fetch("/api/auth/client-config", { signal: controller.signal, credentials: "same-origin" })
      .then(response => {
        if (!response.ok) throw new Error("Account sign-in configuration unavailable");
        return response.json();
      })
      .then(async ids => {
        if (!current) return;
        setSdkClientIds(ids);
        if (ids?.microsoft) void loadMicrosoftSdk()
          .then(() => prepareMicrosoft(ids.microsoft))
          .then(app => { if (current) { microsoftApp.current = app; setSdkReady(state => ({ ...state, microsoft: true })); } })
          .catch(() => { if (current) setMessage("Could not load Microsoft sign-in. You can still choose another provider."); });
        if (ids?.amazon) void loadAmazonSdk()
          .then(() => prepareAmazon(ids.amazon))
          .then(() => { if (current) setSdkReady(state => ({ ...state, amazon: true })); })
          .catch(() => { if (current) setMessage("Could not load Amazon sign-in. You can still choose another provider."); });
      }).catch(() => { if (current) setMessage("Could not load account sign-in settings. Try again with an internet connection."); });
    return () => { current = false; controller.abort(); };
  }, [file, method === "private-key"]);

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
    const request = activeRequest.current;
    request?.controller.abort();
    // Close our preparation/provider tab immediately, even if async parsing
    // or the provider status poll is currently stalled in a background tab.
    try { request?.popup?.close(); } catch { /* The provider may isolate the tab. */ }
    const waiting = pendingAccountSignIn.current;
    pendingAccountSignIn.current = null;
    waiting?.reject(new Error("Account sealing cancelled"));
    setReadyForSignIn(false);
    setPreparedAuthorizeUrl("");
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
        "If the provider tab closed, review any message it showed or cancel and prepare a new sign-in.");
    } catch (error) {
      if (activeRequest.current === request && !request.controller.signal.aborted)
        setMessage("Could not confirm account sign-in: " + error.message +
          " You can cancel and prepare the PDF again.");
    } finally {
      if (activeRequest.current === request) setCheckingAccount(false);
    }
  }

  function openPreparedSignIn(event) {
    const waiting = pendingAccountSignIn.current;
    if (!waiting) {
      event.preventDefault();
      return;
    }
    if (waiting.provider !== method || Date.now() >= waiting.session.startedAt + ACCOUNT_SESSION_SECONDS * 1000) {
      event.preventDefault();
      pendingAccountSignIn.current = null;
      waiting.reject(new Error("Sign-in preparation expired. Prepare the PDF again."));
      setReadyForSignIn(false);
      setPreparedAuthorizeUrl("");
      return;
    }
    // For Amazon only, open the final, already-prepared URL synchronously on
    // the user's click. Script-created tabs are more reliably closable after
    // Amazon redirects back on mobile Chrome. Never open a blank placeholder.
    // If opening fails or its opener cannot be severed, the native noopener
    // link retains its default browser navigation. Google and Microsoft keep
    // their proven native-link behavior unchanged.
    if (method === "amazon" && !event.defaultPrevented &&
        event.button === 0 && !event.ctrlKey && !event.metaKey &&
        !event.shiftKey && !event.altKey &&
        openAmazonSignInTab(waiting.session.authorize_url)) {
      event.preventDefault();
    }
    pendingAccountSignIn.current = null;
    waiting.resolve(null);
    setTimeout(() => {
      if (activeRequest.current && !activeRequest.current.controller.signal.aborted) {
        setReadyForSignIn(false);
        setPreparedAuthorizeUrl("");
        setAuthenticating(true);
      }
    }, 0);
  }

  function beginProviderSealing(id, credentialPromise) {
    if (!file || loading || activeRequest.current) return;
    if (!credentialPromise) {
      setMessage("Could not start the provider's sign-in popup.");
      return;
    }
    setMethod(id);
    setMessage("");
    setSigningIdentity(null);
    // This function is called synchronously from a real user gesture. The
    // provider library owns its popup and reports the verified result.
    void sealPdf(id, credentialPromise, loginNonce);
  }

  function startGoogleClick() {
    let resolveCredential, rejectCredential;
    const promise = new Promise((resolve, reject) => {
      resolveCredential = resolve; rejectCredential = reject;
    });
    googlePending.current = { resolve: resolveCredential, reject: rejectCredential };
    beginProviderSealing("google", promise);
  }

  function completeGoogleClick(credential) {
    googlePending.current?.resolve(credential);
    googlePending.current = null;
  }

  function startOtherProvider(id) {
    try {
      const credentialPromise = id === "microsoft"
        ? microsoftPopup(microsoftApp.current, loginNonce)
        : amazonPopup(loginNonce);
      beginProviderSealing(id, credentialPromise);
    } catch {
      setMessage("Could not open the provider's sign-in popup.");
    }
  }

  async function loadProviderAvailability(id, signal) {
    if (availability?.[id] === true) return;
    const response = await fetch("/api/auth/config", { credentials: "same-origin", signal });
    if (!response.ok) throw new Error("Could not check sign-in availability. Check your connection and retry.");
    const config = await response.json();
    if (!config || typeof config !== "object") throw new Error("Invalid sign-in configuration");
    setAvailability(config);
    if (config[id] !== true) throw new Error(authProvider(id).label + " sealing is not enabled on this installation.");
  }

  async function sealPdf(selectedMethod = method, credentialPromise = null, nonce = loginNonce) {
    const selectedProvider = authProvider(selectedMethod);
    const accountMode = Boolean(selectedProvider);
    if (!file || !selectedMethod || (selectedMethod === "private-key" && !privateKey.trim())) {
      setMessage("Choose a PDF and a sealing method. For local sealing, generate, open, or paste your private key.");
      return;
    }
    if (accountMode && !accountSealingAvailable) {
      setMessage("Account sign-in is not available. Select a different method.");
      setMessage("Account-based sealing is not available in this copy of QRed.");
      return;
    }
    if (activeRequest.current) return;
    const controller = new AbortController();
    const request = { controller, provider: selectedMethod, providerOpened: false };
    activeRequest.current = request;
    let saved = false;
    setLoading(true);
    setSigningIdentity(null);
    setReadyForSignIn(false);
    setPreparedAuthorizeUrl("");
    setAuthenticating(false);
    try {
      if (accountMode) await loadProviderAvailability(selectedMethod, controller.signal);
      // Validate before parsing a PDF so key errors are immediate and actionable.
      const matchingPublicKey = selectedMethod === "private-key" ? await deriveSigningPublicKey(privateKey) : null;
      if (matchingPublicKey) await validateSigningKeyPair({ privateKey, publicKey: matchingPublicKey });
      setMessage(accountMode ? "Preparing your PDF locally before opening " + selectedProvider.label + "…" : "Sealing in this browser…");
      const { blob, sealResult, flattenedFieldCount, footerPages = [] } = await sealPdfInBrowser({
        file,
        ...(selectedMethod === "private-key" ? { privateKey, publicKey: matchingPublicKey } : {
          attestPages: async pages => {
            if (!credentialPromise) throw new Error("Choose a provider to sign in.");
            const session = await beginAccountSignIn(selectedMethod, pages,
              { signal: controller.signal, nonce });
            request.session = session;
            try {
              // The provider SDK owns the window. No QRed preparation tab,
              // blank tab, manual second click, or popup WindowProxy polling.
              const credential = await credentialPromise;
              if (controller.signal.aborted) throw new Error("Account sealing cancelled");
              await completeAccountSignIn(selectedMethod, session, credential, { signal: controller.signal });
              request.providerOpened = true;
              return await attestPagesWithAccount(selectedMethod, pages, {
                popup: null, preparedSession: session, signal: controller.signal,
                onStatus: setMessage, onIdentity: setSigningIdentity,
              });
            } finally {
              // The successful attestation helper clears its own session;
              // this also clears aborted or failed SDK flows.
              await finishAccountSignIn(selectedMethod, session);
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
      const outputName = file.name.replace(/\.pdf$/i, "") + ".qred-sealed.pdf";
      link.download = outputName;
      link.click();
      saved = true;
      URL.revokeObjectURL(url);

      const IS_TEST = typeof window !== "undefined" && window.__qredTestMode === true;
      if (IS_TEST) window.__lastSealResult = sealResult;

      // Keep the confirmation focused on what the user receives. Encoding,
      // QR capacity, timestamps and document IDs remain in the seal itself,
      // not the ordinary success message.
      setMessage([
        `Sealed ${file.name} in this browser.`,
        `Download started: ${outputName}`,
        ...(footerPages.length ? [`Clear footer added to page(s) ${footerPages.join(", ")} to keep seals readable.`] : []),
        ...(flattenedFieldCount ? [`Flattened ${flattenedFieldCount} form field(s). Check the values in your sealed copy.`] : []),
      ].join("\n"));
    } catch (error) {
      setMessage(controller.signal.aborted ? "Account sealing cancelled." : `PDF sealing failed: ${error.message}`);
    } finally {
      // Provider SDKs own and close their popup. QRed retains no tab handle.
      setLoginNonce(createSdkNonce());
      if (activeRequest.current === request) activeRequest.current = null;
      setReadyForSignIn(false);
      setPreparedAuthorizeUrl("");
      setAuthenticating(false);
      setCheckingAccount(false);
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h2>Stamp a PDF</h2>
      <p style={{ color: "#64748b", marginBottom: "1rem" }}>
        Choose your PDF and page layout, then select how to sign it. Your PDF stays on your device; QRed never sends the document to a server.
      </p>
      <div className="demo-grid">
        <div className="demo-input">
          <label htmlFor="pdf-to-stamp">Open PDF</label>
          <input id="pdf-to-stamp" type="file" accept="application/pdf" disabled={loading} onChange={(e) => { setFile(e.target.files?.[0] || null); setLoginNonce(createSdkNonce()); }} />
        </div>
        <div className="demo-input">
          <label>Page layout</label>
          <select
            aria-label="Page layout"
            value={pageScalingStrategy}
            disabled={loading}
            onChange={(e) => { setPageScalingStrategy(e.target.value); setLoginNonce(createSdkNonce()); }}
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

      <p className="key-help">Visual references are approximate. Review small details and form-field values in your saved copy.</p>
      <details className="stamp-method-details">
        <summary>How PDF stamping works</summary>
        <p>QRed seals extracted text and uses spare QR capacity for line locations and a small grayscale visual reference. Image-only pages receive a visual reference, while blank pages receive a signed blank-page marker. Visual references can lose details, including digits and faces. Supported form fields are flattened before sealing.</p>
      </details>
      <div className="demo-input">
        {loading
          ? <p className="sealing-method-selected">Sealing method: {method === "private-key" ? "Private key (offline)" : provider.label + " login"}</p>
          : <fieldset className="sealing-methods">
            <legend>Authenticate and stamp</legend>
            <p className="key-help">Choose a PDF and layout above, then use a provider’s official sign-in button. Your PDF stays on your device.</p>
            {file && method !== "private-key" && <ProviderSdkButtons
              clientIds={sdkClientIds}
              sdkReady={sdkReady}
              nonce={loginNonce}
              busy={!file || loading || loadingKeys}
              onGoogleClick={startGoogleClick}
              onGoogleCredential={completeGoogleClick}
              onMicrosoftClick={() => startOtherProvider("microsoft")}
              onAmazonClick={() => startOtherProvider("amazon")}
              onError={setMessage}
            />}
            <div className="sealing-method-grid offline-signin-choice">
              <button type="button" aria-pressed={method === "private-key"}
                onClick={() => { setMethod("private-key"); setMessage(""); setSigningIdentity(null); }}
                disabled={loading || loadingKeys}>
                Private key (offline)
              </button>
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

      <p id="signing-key-status" role="status" style={{ marginTop: "1rem", color: keyError ? "#ef4444" : "#64748b" }}>{keyStatus}</p>
      {usesAccount && loading && <p role="status" aria-live="polite">
        Preparing and sealing your document… Complete the provider's popup, then return here.
      </p>}
      {method === "private-key" && <button type="button" onClick={() => sealPdf()}
        disabled={loading || loadingKeys} aria-busy={loading} style={{ marginTop: "1rem" }}>
        {loading ? "Sealing..." : "Stamp and save PDF"}
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
