import { createRoot } from "react-dom/client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QrScanner } from "./QrScanner.jsx";
import {
  decodeSeal,
  compareDocumentText,
  qredTextFromScanResult,
  VISIBLE_QR_TEXT,
} from "./qredVerifier.js";
import "./verifier.css";
import { readSigningKeyFile } from "./signingKeys.js";
import { sealCollectionProgress, verifySealCollection } from "./sealCollection.js";

const BUNDLED_PUBLIC_KEY = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";

function parseSealStrings(text) {
  return (text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function renderStatusClass(status) {
  if (status === "VALID") return "result-status valid";
  if (status === "INVALID") return "result-status error";
  return "result-status";
}

function TokenRun({ tokens, kind }) {
  return (
    <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
      {tokens.map((t, idx) => {
        if (t.status === "space") return <React.Fragment key={idx}>{t.token}</React.Fragment>;

        let className = "";
        if (kind === "qr") {
          if (t.status === "matched") className = "diff-token-matched";
          else if (t.status === "missing") className = "diff-token-missing";
        } else {
          if (t.status === "matched") className = "diff-token-matched";
          else if (t.status === "extra") className = "diff-token-extra";
        }

        if (!className) return <React.Fragment key={idx}>{t.token}</React.Fragment>;
        return (
          <span key={idx} className={className}>
            {t.token}
          </span>
        );
      })}
    </div>
  );
}

function OCRComparisonView({ comparison }) {
  if (!comparison) return null;

  return (
    <div className="diff-view" style={{ marginTop: "0.25rem" }}>
      <div className="diff-summary">
        Matched {comparison.matchedWords} words • Missing {comparison.missingWords} • Extra {comparison.extraWords}
      </div>

      <div>
        <div className="diff-label">QR (scanner)</div>
        <TokenRun tokens={comparison.qrTokens} kind="qr" />
      </div>

      <div>
        <div className="diff-label">Page (OCR/pasted)</div>
        <TokenRun tokens={comparison.pageTokens} kind="page" />
      </div>
    </div>
  );
}

function VerifierApp() {
  const [publicKey, setPublicKey] = useState("");
  const [openingKey, setOpeningKey] = useState(false);
  const [keyFileStatus, setKeyFileStatus] = useState("");
  const [sealText, setSealText] = useState("");
  const [pageText, setPageText] = useState("");

  const [result, setResult] = useState(null);
  const [collectionResults, setCollectionResults] = useState([]);
  const [checked, setChecked] = useState(null);
  const [session, setSession] = useState(0);
  const [comparison, setComparison] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ocrStatusText, setOcrStatusText] = useState("");

  const publicKeyRef = useRef(publicKey);
  const resultRunIdRef = useRef(0);

  useEffect(() => {
    publicKeyRef.current = publicKey;
  }, [publicKey]);

  // Default-key resolution (verifier should work offline / API failures)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/api/keys/default");
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (!cancelled) setPublicKey((current) => current || data?.public_key || BUNDLED_PUBLIC_KEY);
      } catch {
        if (!cancelled) setPublicKey((current) => current || BUNDLED_PUBLIC_KEY);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sealStrings = useMemo(() => parseSealStrings(sealText), [sealText]);
  const hasLocalSeals = sealStrings.some(seal => decodeSeal(seal)?.version === "3");
  const collectionProgress = useMemo(() => sealCollectionProgress(sealStrings,
    checked?.seals === sealStrings && checked.publicKey === publicKey ? collectionResults : []),
  [sealStrings, publicKey, checked, collectionResults]);

  async function runVerification(nextSealStrings, nextPublicKey) {
    const runId = ++resultRunIdRef.current;
    setBusy(true);

    try {
      const pk = nextPublicKey ?? publicKeyRef.current ?? "";
      const next = await verifySealCollection(nextSealStrings, pk);
      const activeId = decodeSeal(nextSealStrings.at(-1))?.document_id;
      const res = next.find(item => item.document_id === activeId) || next.at(-1)
        || { status: "ERROR", error_message: "No valid chunks found" };
      if (runId !== resultRunIdRef.current) return;
      setCollectionResults(next);
      setChecked({ seals: nextSealStrings, publicKey: pk });
      setResult(res);
      return res;
    } finally {
      if (runId === resultRunIdRef.current) setBusy(false);
    }
  }

  // Auto-verify whenever seals or public key changes.
  useEffect(() => {
    if (sealStrings.length === 0) {
      resultRunIdRef.current += 1;
      setResult(null);
      setComparison(null);
      setOcrStatusText("");
      return;
    }

    const t = setTimeout(() => {
      runVerification(sealStrings);
    }, 250);

    return () => clearTimeout(t);
  }, [sealStrings, publicKey]);

  // ── Test/standalone harnesses ───────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;

    window.__qredTestVerify = async (sealStringsArg, publicKeyArg) => {
      const seals = Array.isArray(sealStringsArg) ? sealStringsArg : parseSealStrings(String(sealStringsArg || ""));
      const res = await runVerification(seals, publicKeyArg);
      return res;
    };

    // Legacy: some older harnesses call window.verifyQRedSeals
    window.verifyQRedSeals = async (sealStringsArg, publicKeyArg) => {
      const seals = Array.isArray(sealStringsArg) ? sealStringsArg : parseSealStrings(String(sealStringsArg || ""));
      const res = await runVerification(seals, publicKeyArg);
      return res;
    };

    // Legacy test helpers (used by some standalone E2E pages)
    window.__qredStandaloneTestHooks = {
      qredTextFromScanResult,
      VISIBLE_QR_TEXT,
    };
  }, []);

  function onCompare() {
    if (sealStrings.length === 0) return;

    const res = result;
    const content = res?.content || "";
    const comparisonObj = compareDocumentText(content, pageText);
    setComparison(comparisonObj);
    setOcrStatusText("Compared page text.");
  }

  function onClear() {
    resultRunIdRef.current += 1;
    setSession(value => value + 1);
    setCollectionResults([]);
    setChecked(null);
    setSealText("");
    setPageText("");
    setResult(null);
    setComparison(null);
    setOcrStatusText("");
  }

  const appendSealLine = useCallback((newSeal) => {
    if (!newSeal) return;
    setSealText((prev) => {
      const current = parseSealStrings(prev);
      if (current.includes(newSeal)) return prev;
      return prev ? `${prev}\n${newSeal}` : newSeal;
    });
  }, []);

  async function openPublicKeyFile(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setOpeningKey(true);
    setKeyFileStatus("Reading public key on this device...");
    try {
      setPublicKey(await readSigningKeyFile(file, "public"));
      setKeyFileStatus("Public key opened. Collected seals are checked with this key.");
    } catch (error) {
      setKeyFileStatus(`Key import failed: ${error.message}`);
    } finally {
      setOpeningKey(false);
    }
  }

  return (
    <div className="verifier-page">
      <header>
        <h1>QRed Verifier</h1>
        <p>Scan QR seals with your camera to verify a document.</p>
        <p>Google seals automatically select a trusted authority key included in QRed.</p>
        <p>Camera frames and seal text are processed in this browser and are not sent to a server.</p>
        <details>
          <summary>Optional: use airplane mode</summary>
          <p>Load QRed, then enable airplane mode and turn Wi-Fi and Bluetooth off in your device settings to limit network access while you work. Keep this tab open.</p>
          <p>Try your workflow with a non-sensitive file before opening sensitive documents. Some PDF fonts and text-recognition resources may still need an internet connection.</p>
        </details>
      </header>

      <main>
        <QrScanner
          key={session}
          returnPayload
          collectSeals
          collectionProgress={collectionProgress}
          onSealDetected={appendSealLine}
        />

        <section className="result-card" style={{ marginTop: "1.25rem" }}>
          {hasLocalSeals && <div>
            <p>This collection includes a seal made with a private key file. Obtain the issuer’s public key file through a trusted channel to verify it.</p>
            <label htmlFor="publicKeyFileInput" className="field-label">Open issuer public key file</label>
            <input id="publicKeyFileInput" type="file" accept=".txt,text/plain" className="field-input file-input" onChange={openPublicKeyFile} disabled={openingKey} />
            <p role="status">{keyFileStatus}</p>
          </div>}

          <label htmlFor="pageTextInput" className="field-label">
            Page text read by scanner or pasted for comparison
          </label>
          <textarea
            id="pageTextInput"
            rows={4}
            value={pageText}
            onChange={(e) => setPageText(e.target.value)}
            placeholder="Scan QR Code to OCR the page, or paste document text here to compare"
            className="field-input"
            style={{ resize: "vertical" }}
          />

          <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.75rem" }}>
            <button id="btnCompareText" className="btn btn-secondary" type="button" onClick={onCompare} disabled={!result || busy}>
              Compare page text
            </button>
            <button id="btnClear" className="btn btn-secondary" type="button" onClick={onClear}>
              Clear
            </button>
          </div>

          <div id="ocrStatus" className="ocr-status" aria-live="polite">
            {ocrStatusText}
          </div>
        </section>

        <section id="resultView" className={result ? "result-view visible" : "result-view"}>
          <div id="resultStatus" className={result ? renderStatusClass(result.status) : "result-status"}>
            {result ? result.status : ""}
          </div>
          <div id="resultMeta" className="result-meta">
            {result?.document_id ? (
              <div className="meta-item">
                <strong>Document:</strong> {result.document_id}
              </div>
            ) : null}
            {result?.timestamp ? (
              <div className="meta-item">
                <strong>{result.metadata_authenticated ? "Seal time" : "Claimed seal time"} (signer’s clock):</strong> <time dateTime={result.timestamp}>{result.timestamp}</time>
              </div>
            ) : null}
            {result?.pdf ? (
              <div className="meta-item"><strong>Page:</strong> {result.page_number} of {result.page_count}</div>
            ) : null}
            {result?.document_root ? (
              <div className="meta-item"><strong>Document fingerprint:</strong> {result.document_root}</div>
            ) : null}
            {result?.encoding ? (
              <div className="meta-item">
                <strong>Encoding:</strong> {result.encoding}
              </div>
            ) : null}
            {result?.key_id ? (
              <div className="meta-item">
                <strong>Key ID:</strong> {result.key_id}
              </div>
            ) : null}
            {result?.error_message ? (
              <div className="meta-item" style={{ color: "#ef4444" }}>
                {result.error_message}
              </div>
            ) : null}
          </div>
          <div id="resultContent" className="result-content">
            {result?.content ? result.content : result?.error_message ? result.error_message : ""}
          </div>
          <div id="textCompareView" className="text-compare-view">
            <OCRComparisonView comparison={comparison} />
          </div>
        </section>
      </main>

      <footer style={{ textAlign: "center", padding: "1rem", color: "#94a3b8", fontSize: "0.85rem" }}>
        QRed — Tamper-Evident Document Sealing <span className="app-version" id="appVersion">vrefactor</span>
      </footer>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<VerifierApp />);
}
