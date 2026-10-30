/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import { sealPdfInBrowser, prepareAccountPdfSeal } from "./pdfClientSeal.js";
import { decodeSigningKey, deriveSigningPublicKey, generateSigningKeyPair, readSigningKeyFile, validateSigningKeyPair } from "./signingKeys.js";
import { encodeBase64Url } from "./sealSignature.js";
import { beginAccountSignIn, finishAccountSignIn, checkAccountSignInStatus, attestPagesWithAccount, accountSealingAvailable } from "./accountSealing.js";
import { AUTH_PROVIDERS, authProvider } from "./authProviders.js";
import { ProviderMark } from "./ProviderMark.jsx";
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
  const [method, setMethod] = useState(null);
  const [preparedProviders, setPreparedProviders] = useState(null);
  const [preparingProviders, setPreparingProviders] = useState(false);
  const [prepareError, setPrepareError] = useState("");
  const [prepareRetry, setPrepareRetry] = useState(0);
  const [authenticating, setAuthenticating] = useState(false);
  const [checkingAccount, setCheckingAccount] = useState(false);
  const [signingIdentity, setSigningIdentity] = useState(null);
  const [availability, setAvailability] = useState(null);
  const [configError, setConfigError] = useState("");
  const [configAttempt, setConfigAttempt] = useState(0);
  const provider = authProvider(method);
  const usesAccount = Boolean(provider);
  const activeRequest = useRef(null);
  const preparedRef = useRef(null);
  const preparationRef = useRef(null);
  const derivedFor = useRef("");

  // Prepare everything that could stall Android's backgrounded QRed tab
  // before enabling one-tap provider links. No copies of the PDF are stored:
  // the prepared plans and original File remain only in this tab's memory.
  useEffect(() => {
    if (!file || method === "private-key" || !accountSealingAvailable) {
      setPreparedProviders(null);
      setPreparingProviders(false);
      return;
    }
    let current = true;
    const controller = new AbortController();
    const createdSessions = [];
    const currentPreparation = { controller, sessions: createdSessions };
    preparationRef.current = currentPreparation;
    preparedRef.current = null;
    setPreparedProviders(null);
    setPreparingProviders(true);
    setPrepareError("");
    setSigningIdentity(null);
    const work = async () => {
      const response = await fetch("/api/auth/config", {
        signal: controller.signal, credentials: "same-origin",
      });
      if (!response.ok) throw new Error("Could not check account sign-in availability");
      const config = await response.json();
      if (!config || typeof config !== "object") throw new Error("Invalid account sign-in configuration");
      const enabled = Object.keys(AUTH_PROVIDERS).filter(id => config[id] === true);
      if (!enabled.length) throw new Error("No account sign-in providers are enabled");
      const prepared = await prepareAccountPdfSeal({
        file, bootstrapUrl: BOOTSTRAP_URL, encodingStrategy: "automatic", pageScalingStrategy,
      });
      if (controller.signal.aborted) return;
      const results = await Promise.allSettled(enabled.map(async providerId => {
        const session = await beginAccountSignIn(providerId, prepared.pages, {
          signal: controller.signal,
        });
        createdSessions.push(session);
        return [providerId, session];
      }));
      if (!current || controller.signal.aborted) return;
      const sessions = Object.fromEntries(results.filter(result => result.status === "fulfilled")
        .map(result => result.value));
      if (!Object.keys(sessions).length) {
        const failed = results.find(result => result.status === "rejected");
        throw failed?.reason || new Error("Account sign-in preparation failed");
      }
      const value = { file, pageScalingStrategy, prepared, sessions };
      preparedRef.current = value;
      setPreparedProviders(value);
      setPreparingProviders(false);
    };
    void work().catch(error => {
      if (current && !controller.signal.aborted) {
        setPreparedProviders(null);
        setPreparingProviders(false);
        setPrepareError("Could not prepare sign-in: " + error.message);
      }
    });
    return () => {
      current = false;
      controller.abort();
      if (preparationRef.current === currentPreparation) preparationRef.current = null;
      if (preparedRef.current?.file === file) preparedRef.current = null;
      // The chosen session is cleaned by the attestation helper; discard
      // other stateless session cookies when a PDF/layout/method changes.
      for (const session of createdSessions) {
        if (activeRequest.current?.session === session) continue;
        void finishAccountSignIn(session.provider, session);
      }
    };
  }, [file, pageScalingStrategy, method === "private-key", prepareRetry]);

  useEffect(() => () => {
    activeRequest.current?.controller.abort();
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
    setAuthenticating(false);
    setMessage("Account sealing cancelled.");
    setPrepareRetry(value => value + 1);
  }

  async function checkSignInStatus() {
    const request = activeRequest.current;
    if (!request?.session || request.controller.signal.aborted) return;
    setCheckingAccount(true);
    try {
      const result = await checkAccountSignInStatus(request.provider, request.session,
        { signal: request.controller.signal });
      if (activeRequest.current !== request) return;
      if (result.status === "ready") setMessage("Account sign-in verified. Finishing PDF sealing locally…");
      else if (result.status === "failed") setMessage("Account sign-in failed: " +
        (result.error || "The provider could not complete sign-in."));
      else setMessage("Sign-in is not complete yet. Return here after using the provider's login window.");
    } catch (error) {
      if (activeRequest.current === request && !request.controller.signal.aborted) {
        setMessage("Could not check sign-in status: " + error.message);
      }
    } finally {
      if (activeRequest.current === request) setCheckingAccount(false);
    }
  }

  function startPreparedProvider(event, id) {
    const prepared = preparedRef.current;
    const session = prepared?.sessions?.[id];
    if (!prepared || !session || prepared.file !== file ||
        prepared.pageScalingStrategy !== pageScalingStrategy || activeRequest.current ||
        Date.now() >= session.startedAt + ACCOUNT_SESSION_SECONDS * 1000 - 10000) {
      event.preventDefault();
      if (!activeRequest.current) {
        setMessage("Sign-in preparation expired. Preparing a fresh authorization…");
        setPrepareRetry(value => value + 1);
      }
      return;
    }
    // Browser handles the native, noopener provider link *synchronously*
    // within this gesture, without opening a QRed preparation page.
    const request = { controller: new AbortController(), provider: id, session };
    activeRequest.current = request;
    setMethod(id);
    setAuthenticating(true);
    setLoading(true);
    setMessage("Complete " + authProvider(id).label + " sign-in. Your PDF remains open in QRed.");
    void (async () => {
      try {
        const receipts = await attestPagesWithAccount(id, prepared.prepared.pages, {
          popup: null, preparedSession: session, signal: request.controller.signal,
          onIdentity: setSigningIdentity, onStatus: setMessage,
        });
        if (request.controller.signal.aborted) return;
        const { blob, sealResult, flattenedFieldCount, footerPages = [] } =
          await prepared.prepared.finish(receipts);
        if (request.controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        const outputName = file.name.replace(/\\.pdf$/i, "") + ".qred-sealed.pdf";
        try {
          const link = document.createElement("a");
          link.href = url;
          link.download = outputName;
          link.click();
        } finally { URL.revokeObjectURL(url); }
        if (typeof window !== "undefined" && window.__qredTestMode === true) {
          window.__lastSealResult = sealResult;
        }
        setMessage([
          "Sealed " + file.name + " in this browser.",
          "Download started: " + outputName,
          ...(footerPages.length ? ["Clear footer added to page(s) " + footerPages.join(", ") + " to keep seals readable."] : []),
          ...(flattenedFieldCount ? ["Flattened " + flattenedFieldCount + " form field(s). Check the values in your sealed copy."] : []),
        ].join("\\n"));
      } catch (error) {
        setMessage(request.controller.signal.aborted ? "Account sealing cancelled." :
          "PDF sealing failed: " + error.message);
      } finally {
        if (activeRequest.current === request) activeRequest.current = null;
        setLoading(false);
        setAuthenticating(false);
        setCheckingAccount(false);
        setPrepareRetry(value => value + 1);
      }
    })();
  }

  async function sealPdf(selectedMethod = method) {
    const selectedProvider = authProvider(selectedMethod);
    const accountMode = Boolean(selectedProvider);
    if (!file || !selectedMethod || (selectedMethod === "private-key" && !privateKey.trim())) {
      setMessage("Choose a PDF and a sealing method. For local sealing, generate, open, or paste your private key.");
      return;
    }
    if (accountMode) {
      setMessage("Choose one of the prepared sign-in links.");
      return;
    }
    if (activeRequest.current) return;
    const controller = new AbortController();
    const request = { controller };
    activeRequest.current = request;
    let saved = false;
    setLoading(true);
    setSigningIdentity(null);
    setAuthenticating(false);
    try {
      // Private-key/offline sealing never requires an account network request.
      const matchingPublicKey = selectedMethod === "private-key" ? await deriveSigningPublicKey(privateKey) : null;
      if (matchingPublicKey) await validateSigningKeyPair({ privateKey, publicKey: matchingPublicKey });
      setMessage(accountMode ? "Preparing your PDF locally before opening " + selectedProvider.label + "…" : "Sealing in this browser…");
      const { blob, sealResult, flattenedFieldCount, footerPages = [] } = await sealPdfInBrowser({
        file, privateKey, publicKey: matchingPublicKey, bootstrapUrl: BOOTSTRAP_URL,
        encodingStrategy: "automatic", pageScalingStrategy,
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
      if (activeRequest.current === request) activeRequest.current = null;
          setAuthenticating(false);
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
          <input id="pdf-to-stamp" type="file" accept="application/pdf" disabled={loading} onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </div>
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
            <p className="key-help">Choose your PDF and layout first. QRed prepares authentication securely; a single tap then opens the provider directly.</p>
            <div className="sealing-method-grid">
              {Object.entries(AUTH_PROVIDERS).map(([id, account]) => {
                const session = preparedProviders?.sessions?.[id];
                const usable = file && !loading && !loadingKeys && session &&
                  Date.now() < session.startedAt + ACCOUNT_SESSION_SECONDS * 1000 - 10000;
                const label = account.button;
                return usable ? <a key={id} href={session.authorize_url}
                  target="_blank" rel="noopener noreferrer" className="account-provider-choice"
                  aria-label={label} onClick={event => startPreparedProvider(event, id)}>
                  <ProviderMark provider={id} /><span>{label}</span>
                </a> : <button key={id} type="button" disabled aria-label={label}
                  className="account-provider-choice" aria-busy={Boolean(preparingProviders && file && method !== "private-key")}>
                  <ProviderMark provider={id} /><span>{label}</span>
                </button>;
              })}
              <button type="button" aria-pressed={method === "private-key"}
                onClick={() => { setMethod("private-key"); setMessage(""); setSigningIdentity(null); }}
                disabled={loading || loadingKeys}>
                Private key (offline)
              </button>
            </div>
            {file && method !== "private-key" && preparingProviders &&
              <p className="key-help" role="status">Preparing secure sign-in links locally…</p>}
            {file && method !== "private-key" && prepareError &&
              <p role="status">{prepareError} <button type="button" onClick={() =>
                setPrepareRetry(value => value + 1)}>Retry preparation</button></p>}
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
      {method === "private-key" && <button type="button" onClick={sealPdf}
        disabled={loading || loadingKeys} aria-busy={loading} style={{ marginTop: "1rem" }}>
        {loading ? "Sealing..." : "Stamp and save PDF"}
      </button>}
      {usesAccount && <p id="account-sealing-action" className="key-help">
        {authenticating
          ? "Complete sign-in in the provider tab, then return to QRed. Your original PDF stays in memory."
          : "The provider opens directly in a separate, isolated browser tab. No sign-in SDK runs in this document page."}
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
