import { useCallback, useEffect, useState } from "react";
import { scanQrImage } from "./qr/scanQrImage.js";
import { decodeSeal, qredPayloadFromPhotoScanResult, verifyQRedSeals, VISIBLE_QR_TEXT } from "./qredVerifier.js";
import { readSigningKeyFile } from "./signingKeys.js";

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
      setNotice("QR found, but its hidden payload could not be read. Move closer or choose a clearer image.");
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
  const [openingKey, setOpeningKey] = useState(false);
  const [keyFileStatus, setKeyFileStatus] = useState("");
  const { publicKey, setPublicKey, results, notice, setNotice, busy, addSeal } = verification;

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
      const code = scanQrImage(pixels.data, pixels.width, pixels.height);
      if (!code) throw new Error("No QR code found. Choose a clear image of one seal.");
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
    <p className="verification-note">QR images and camera frames are processed in this browser and are not sent to a server.</p>
    <details>
      <summary>Optional: use airplane mode</summary>
      <p>Load QRed, then enable airplane mode and turn Wi-Fi and Bluetooth off in your device settings to limit network access while you work. Keep this tab open.</p>
      <p>Try your workflow with a non-sensitive file before opening sensitive documents. Some PDF fonts and text-recognition resources may still need an internet connection.</p>
    </details>
    <label htmlFor="issuer-verification-key">Issuer public key</label>
    <input id="issuer-verification-key" value={publicKey} onChange={(event) => { setPublicKey(event.target.value); setKeyFileStatus(""); }} disabled={openingKey} />
    <label htmlFor="issuer-public-key-file">Open issuer public key file</label>
    <input id="issuer-public-key-file" type="file" accept=".txt,text/plain" onChange={openPublicKeyFile} disabled={openingKey} />
    <p role="status">{keyFileStatus}</p>
    <p className="verification-note">Use a key obtained from the issuer through a trusted channel. The default demo key is public test data and proves no issuer identity.</p>
    <label htmlFor="qr-image">Choose QR image</label>
    <input id="qr-image" type="file" accept="image/*" onChange={readImage} />
    <button type="button" onClick={verification.clear}>Clear collected seals</button>
    <div aria-live="polite">
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">Verifying…</p>}
      {results.map((result, index) => <article key={result.document_id || index} className="verification-result">
        <h3>{result.status}</h3>
        <p>Document: {result.document_id}</p>
        {result.timestamp && <p>{result.metadata_authenticated ? "Seal time" : "Claimed seal time"} (signer’s clock): <time dateTime={result.timestamp}>{result.timestamp}</time></p>}
        {result.key_id && <p>Key ID: {result.key_id}</p>}
        {result.pdf && <p>Page {result.page_number} of {result.page_count}</p>}
        {result.document_root && <p>Document fingerprint: {result.document_root}</p>}
        {result.error_message && <p>{result.error_message}</p>}
        {result.status === "INCOMPLETE" && <p>{result.collected_chunks} of {result.total_chunks} seals collected. Scan the remaining seals.</p>}
        {result.content && <pre>{result.content}</pre>}
      </article>)}
    </div>
  </section>;
}
