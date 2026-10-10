import React, { useCallback, useEffect, useState } from "react";
import jsQR from "jsqr";
import { decodeSeal, qredPayloadFromPhotoScanResult, verifyQRedSeals, VISIBLE_QR_TEXT } from "./qredVerifier.js";

export function useSealVerification() {
  const [seals, setSeals] = useState([]);
  const [publicKey, setPublicKey] = useState("");
  const [results, setResults] = useState([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    fetch("/api/keys/default", { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((keys) => {
        if (cancelled || !keys?.public_key) return;
        setPublicKey((current) => current || keys.public_key);
      })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, []);

  const addSeal = useCallback((text) => {
    if (text === VISIBLE_QR_TEXT) {
      setNotice("QR found, but its hidden payload could not be read. Move closer or upload a clearer image.");
      return;
    }
    if (!decodeSeal(text)) {
      setNotice(`Unverified QR content: ${text}`);
      return;
    }
    setNotice("");
    setSeals((previous) => previous.includes(text) ? previous : [...previous, text]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const groups = new Map();
    for (const seal of seals) {
      const id = decodeSeal(seal).document_id;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(seal);
    }
    setBusy(groups.size > 0);
    setResults([]);
    Promise.all([...groups.values()].map((group) => verifyQRedSeals(group, publicKey)))
      .then((next) => { if (!cancelled) setResults(next); })
      .catch((error) => { if (!cancelled) setNotice(`Verification failed: ${error.message}`); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [seals, publicKey]);

  return { seals, publicKey, setPublicKey, results, notice, setNotice, busy, addSeal,
    clear: () => { setSeals([]); setResults([]); setNotice(""); } };
}

export function SealVerification({ verification }) {
  const [manual, setManual] = React.useState("");
  const { publicKey, setPublicKey, results, notice, setNotice, busy, addSeal } = verification;

  async function readImage(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" });
      if (!code) throw new Error("No QR code found. Upload a clear image of one seal.");
      addSeal(qredPayloadFromPhotoScanResult(pixels.data, pixels.width, pixels.height, code));
    } catch (error) {
      setNotice(error.message);
    } finally {
      URL.revokeObjectURL(url);
      event.target.value = "";
    }
  }

  return <section className="verification-card" aria-label="Seal verification">
    <h2>Verify collected seals</h2>
    <p>Scan each QR seal for a page. A valid signature authenticates the recovered text and signed metadata against the public key below. Compare the recovered text with the document.</p>
    <label htmlFor="issuer-verification-key">Issuer public key</label>
    <input id="issuer-verification-key" value={publicKey} onChange={(event) => setPublicKey(event.target.value)} />
    <p className="verification-note">Use a key obtained from the issuer through a trusted channel. The default demo key is public test data and proves no issuer identity.</p>
    <label htmlFor="qr-image">QR image</label>
    <input id="qr-image" type="file" accept="image/*" onChange={readImage} />
    <details>
      <summary>Manual seal entry</summary>
      <label htmlFor="manual-seals">Seal strings, one per line</label>
      <textarea id="manual-seals" rows={4} value={manual} onChange={(event) => setManual(event.target.value)} />
      <button type="button" onClick={() => manual.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach(addSeal)}>Add seals</button>
    </details>
    <button type="button" onClick={() => { verification.clear(); setManual(""); }}>Clear collected seals</button>
    <div aria-live="polite">
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">Verifying…</p>}
      {results.map((result, index) => <article key={result.document_id || index} className="verification-result">
        <h3>{result.status}</h3>
        <p>Document: {result.document_id}</p>
        {result.issuer && <p>{result.metadata_authenticated ? "Issuer" : "Claimed issuer (not authenticated)"}: {result.issuer}</p>}
        {result.error_message && <p>{result.error_message}</p>}
        {result.status === "INCOMPLETE" && <p>{result.collected_chunks} of {result.total_chunks} seals collected. Scan the remaining seals.</p>}
        {result.content && <pre>{result.content}</pre>}
      </article>)}
    </div>
  </section>;
}
