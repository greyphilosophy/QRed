/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import { sealExactPdf, verifyExactPdf } from "./exactRender/exactPdf.js";
import { decodeSigningKey, deriveSigningPublicKey, generateSigningKeyPair, readSigningKeyFile, validateSigningKeyPair } from "./signingKeys.js";
import { encodeBase64Url } from "./sealSignature.js";
import "./exactPdfExperiment.css";

const MAX_PDF_BYTES = 32 * 1024 * 1024;
const SIGNATURE_LABELS = {
  VALID: "Authenticated", INVALID: "Invalid", UNVERIFIED: "Not verified",
  INCOMPLETE: "Incomplete", UNSUPPORTED: "Unsupported",
};

// Even an inconsistent/partly upgraded producer must not paint a page green
// without both an authenticated signature and exact appearance evidence.
function matched(page) {
  return page.signatureStatus === "VALID" && page.exactRender?.status === "exact-render-match";
}

export default function ExactPdfExperiment({ onClose }) {
  const [file, setFile] = useState(null);
  const [privateKey, setPrivateKey] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [sealed, setSealed] = useState(null);
  const request = useRef(null);
  const keyRevision = useRef(0);
  const downloads = useRef(new Map());
  const heading = useRef(null);
  const pdfInput = useRef(null);
  const privateInput = useRef(null);
  const publicInput = useRef(null);

  function revokeDownloads() {
    for (const [url, timer] of downloads.current) {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
    }
    downloads.current.clear();
  }

  function invalidate(text = "") {
    request.current?.abort();
    request.current = null;
    revokeDownloads();
    setBusy(false);
    setProgress(null);
    setResult(null);
    setSealed(null);
    setMessage(text);
  }

  function clear() {
    keyRevision.current += 1;
    invalidate("Experimental check cleared. Documents and keys released from this tool.");
    setFile(null);
    setPrivateKey("");
    setPublicKey("");
    setKeyBusy(false);
    for (const input of [pdfInput, privateInput, publicInput]) if (input.current) input.current.value = "";
  }

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView?.({ block: "start" });
    window.addEventListener("pagehide", clear);
    return () => {
      keyRevision.current += 1;
      request.current?.abort();
      request.current = null;
      revokeDownloads();
      window.removeEventListener("pagehide", clear);
    };
  }, []);

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    const timer = setTimeout(() => { URL.revokeObjectURL(url); downloads.current.delete(url); }, 1000);
    downloads.current.set(url, timer);
  }

  async function changePrivateKey(value) {
    const revision = ++keyRevision.current;
    invalidate();
    setPrivateKey(value);
    setPublicKey("");
    setKeyBusy(Boolean(value.trim()));
    if (!value.trim()) return;
    try {
      const key = await deriveSigningPublicKey(value);
      if (revision === keyRevision.current) setPublicKey(key);
    } catch (error) {
      if (revision === keyRevision.current) setMessage(error.message);
    } finally {
      if (revision === keyRevision.current) setKeyBusy(false);
    }
  }

  function changePublicKey(value) {
    keyRevision.current += 1;
    invalidate();
    setKeyBusy(false);
    setPublicKey(value);
  }

  async function generateKeys() {
    if ((privateKey || publicKey) && !window.confirm("Replace these experimental keys? Save your private key first if you need it later.")) return;
    const revision = ++keyRevision.current;
    invalidate();
    setKeyBusy(true);
    try {
      const keys = await generateSigningKeyPair();
      if (revision !== keyRevision.current) return;
      setPrivateKey(keys.privateKey);
      setPublicKey(keys.publicKey);
      setMessage("Key pair generated locally. Save your private key securely to reuse this signing identity.");
    } catch (error) {
      if (revision === keyRevision.current) setMessage(error.message);
    } finally {
      if (revision === keyRevision.current) setKeyBusy(false);
    }
  }

  async function openKey(event, kind) {
    const selected = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!selected) return;
    const revision = ++keyRevision.current;
    invalidate();
    setKeyBusy(true);
    try {
      const key = await readSigningKeyFile(selected, kind);
      const derived = kind === "private" ? await deriveSigningPublicKey(key) : null;
      if (revision !== keyRevision.current) return;
      if (kind === "private") { setPrivateKey(key); setPublicKey(derived); }
      else setPublicKey(key);
      setMessage(`${kind === "private" ? "Private" : "Public"} key opened locally.`);
    } catch (error) {
      if (revision === keyRevision.current) setMessage(error.message);
    } finally {
      if (revision === keyRevision.current) setKeyBusy(false);
    }
  }

  function saveKey(kind) {
    try {
      const key = encodeBase64Url(decodeSigningKey(kind === "private" ? privateKey : publicKey, kind));
      saveBlob(new Blob([key + "\n"], { type: "text/plain;charset=utf-8" }), `qred-ed25519-${kind}-key.txt`);
      setMessage(kind === "private" ? "Private key download is unencrypted. Keep it secret and store it securely." : "Share the public key through a trusted channel.");
    } catch (error) { setMessage(error.message); }
  }

  function choosePdf(event) {
    const selected = event.currentTarget.files?.[0];
    event.currentTarget.value = ""; // Selecting the same file again is a new check.
    if (!selected) return;
    invalidate();
    setFile(null);
    if (!/\.pdf$/i.test(selected.name) || (selected.type && selected.type !== "application/pdf")) {
      setMessage("Choose a digital PDF, not a photo or image. This experiment cannot verify printed pages.");
    } else if (selected.size > MAX_PDF_BYTES) {
      setMessage("Choose a PDF no larger than 32 MiB.");
    } else setFile(selected);
  }

  async function run(mode) {
    if (request.current || keyBusy) return;
    invalidate();
    if (!file) { setMessage("Choose a digital PDF first."); return; }
    const controller = new AbortController();
    request.current = controller;
    const current = () => request.current === controller && !controller.signal.aborted;
    setBusy(true);
    try {
      decodeSigningKey(publicKey, "public");
      if (mode === "seal") {
        const checked = await validateSigningKeyPair({ privateKey, publicKey });
        checked.privateBytes.fill(0); // This copy is needed only for validation.
      }
      if (!current()) return;
      const options = { file, publicKey, signal: controller.signal,
        onProgress: value => { if (current()) setProgress(value); } };
      if (mode === "seal") {
        const value = await sealExactPdf({ ...options, privateKey });
        if (!current()) return;
        saveBlob(value.blob, file.name.replace(/\.pdf$/i, "") + "-exact-sealed.pdf");
        setSealed({ pages: value.pages, profile: value.profile, scope: value.scope });
        setMessage("Exact appearance sealed and PDF download started. Reopen the saved PDF to check it independently.");
      } else {
        const value = await verifyExactPdf(options);
        if (!current()) return;
        setResult(value);
        setMessage("Exact rendered-appearance check finished. Read signature and appearance results separately below.");
      }
    } catch (error) {
      if (current()) setMessage(error.name === "AbortError" ? "Experimental operation cancelled." : `Experimental ${mode === "seal" ? "sealing" : "verification"} failed: ${error.message}`);
    } finally {
      if (current()) { request.current = null; setBusy(false); setProgress(null); }
    }
  }

  const pages = result?.pages || [];
  const complete = result?.completeExactRenderedDocument === true && pages.length > 0 && pages.every(matched);
  return <section className="exact-pdf-experiment" aria-labelledby="exact-pdf-heading">
    <div className="exact-tool-heading">
      <div><p className="eyebrow">Opt-in experiment · Digital PDFs only</p><h2 id="exact-pdf-heading" tabIndex={-1} ref={heading}>Exact rendered appearance</h2></div>
      <button type="button" onClick={onClose}>Close exact PDF experiment</button>
    </div>
    <p>This separate experiment checks every rendered page pixel against a signed appearance, except for exact authenticated seal artwork. It does not use OCR or compare extracted text.</p>
    <p className="exact-scope" data-testid="exact-scope">A match is not a claim of semantic correctness, unchanged PDF bytes, or unchanged hidden fields or attachments. It does not verify prints or photos. It applies only to this experimental browser rendering procedure at 144 dpi. The profile identifies the procedure, not a measured or attested browser runtime. Native canvas rendering can differ across devices or platforms, so an unchanged PDF may be inconclusive elsewhere. Changes invisible to this rendering are outside the claim.</p>
    <p>PDFs and keys stay in this tab’s memory. This tool does not upload or persist them. Only public app assets are cached. Offline use requires loading the needed same-origin assets first. Closing, clearing or leaving this page releases the tool’s data; this is not forensic erasure.</p>
    <details><summary>Experimental limits and trust</summary><p>At most 32 MiB, 100 pages and 3 million rendered pixels per page. The source needs enough wholly white space for sixteen seal boxes. Unsupported geometry, forms, annotations or insufficient space fail rather than silently changing layout. These limits do not bound PDF parser or embedded-image decoder memory or time; malicious or complex PDFs may stall or exhaust the browser. There is no account sign-in. Use the issuer’s public key from a trusted channel; a matching signature alone does not establish a real-world identity.</p></details>
    <label htmlFor="exact-pdf-file">Open exact-mode PDF</label>
    <input id="exact-pdf-file" ref={pdfInput} type="file" accept=".pdf,application/pdf" onChange={choosePdf} />
    {file && <p className="exact-file-name">Selected PDF: {file.name}</p>}
    <label htmlFor="exact-private-key">Exact-mode private key (for sealing only)</label>
    <input id="exact-private-key" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={privateKey} onChange={event => void changePrivateKey(event.target.value)} />
    <label htmlFor="exact-private-key-file">Open exact-mode private key file</label>
    <input id="exact-private-key-file" ref={privateInput} type="file" accept=".txt,text/plain" onChange={event => void openKey(event, "private")} />
    <label htmlFor="exact-public-key">Exact-mode public key</label>
    <input id="exact-public-key" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} value={publicKey} onChange={event => changePublicKey(event.target.value)} />
    <label htmlFor="exact-public-key-file">Open exact-mode public key file</label>
    <input id="exact-public-key-file" ref={publicInput} type="file" accept=".txt,text/plain" onChange={event => void openKey(event, "public")} />
    <p>Verification needs only the sealed PDF and public key. No original document or source reference is required.</p>
    <div className="exact-actions">
      <button type="button" disabled={busy || keyBusy} onClick={() => void generateKeys()}>Generate experimental key pair</button>
      <button type="button" disabled={busy || keyBusy || !privateKey.trim()} onClick={() => saveKey("private")}>Save experimental private key</button>
      <button type="button" disabled={busy || keyBusy || !publicKey.trim()} onClick={() => saveKey("public")}>Save experimental public key</button>
    </div>
    <div className="exact-actions">
      <button type="button" disabled={busy || keyBusy} onClick={() => void run("seal")}>Seal exact appearance and save PDF</button>
      <button type="button" disabled={busy || keyBusy} onClick={() => void run("verify")}>Verify exact rendered appearance</button>
      {busy && <button type="button" onClick={() => invalidate("Experimental operation cancelled.")}>Cancel exact operation</button>}
      <button type="button" onClick={clear}>Clear experimental documents and keys</button>
    </div>
    <p role="status" className="exact-status" aria-live="polite">{keyBusy ? "Preparing keys locally…" : progress ? `${progress.stage}${progress.pageNumber ? ` · Page ${progress.pageNumber} of ${progress.pageCount}` : ""}` : message}</p>
    {sealed && <p className="exact-profile">Sealed {sealed.pages.length} page(s). Rendering profile: {sealed.profile}. {sealed.scope}</p>}
    {result && <div className="exact-results" aria-label="Exact PDF results">
      <h3>Document result</h3>
      <p className={complete ? "exact-match" : "exact-inconclusive"} data-testid="exact-document-result">{complete ? "Complete exact rendered document match" : "Complete exact rendered document match not established"}</p>
      <p className="exact-profile">Rendering profile: {result.profile}. {result.scope}</p>
      {pages.map((page, index) => <article key={`${page.pageNumber}-${index}`} className="exact-page-result" aria-label={`Exact result page ${page.pageNumber}`} data-appearance-status={matched(page) ? "exact-render-match" : "inconclusive"}>
        <h4>Page {page.pageNumber}</h4>
        <p className="exact-signature">Signature: {SIGNATURE_LABELS[page.signatureStatus] || "Not verified"}</p>
        <p className={matched(page) ? "exact-match" : "exact-inconclusive"}>Appearance: {matched(page) ? "Exact rendered appearance matches" : "Inconclusive: exact rendered appearance not established"}</p>
        {!matched(page) && <p>{page.exactRender?.reason || "An authenticated signature and an exact rendered-appearance match are both required."}</p>}
      </article>)}
    </div>}
  </section>;
}
