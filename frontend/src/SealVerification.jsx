import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { scanQrImage } from "./qr/scanQrImage.js";
import { scanPageAlignedImage } from "./qr/pageAlignedScan.js";
import { decodeSeal, qredPayloadFromPhotoScanResult, VISIBLE_QR_TEXT } from "./qredVerifier.js";
import { isQRedEntryLink } from "./qr/hiddenPayload.js";
import { readSigningKeyFile } from "./signingKeys.js";
import { createVerificationSession } from "./verifier/verificationSession.js";
import { PhotoTextVerification } from "./verifier/PhotoTextVerification.jsx";
import { createScanPhotoCollection } from "./verifier/scanPhotos.js";
import { PdfSealInput } from "./verifier/PdfSealInput.jsx";
import { authProvider } from "./authProviders.js";

export function useSealVerification() {
  const [collection] = useState(createVerificationSession);
  const snapshot = useSyncExternalStore(collection.subscribe, collection.getSnapshot);
  const { seals } = snapshot;
  const [publicKey, setPublicKey] = useState("");
  const [notice, setNotice] = useState("");
  const [scanImages, setScanImages] = useState({ photos: [], notice: "" });
  const [photoCollection] = useState(() => createScanPhotoCollection(setScanImages));
  useEffect(() => () => photoCollection.clear(), [photoCollection]);

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

  const addSeal = useCallback((text, frame, { replaceImage = false } = {}) => {
    if (isQRedEntryLink(text) && text !== VISIBLE_QR_TEXT) {
      setNotice("That code opens qred.org. Scan the pale watermark to read the document seal.");
      return;
    }
    if (text === VISIBLE_QR_TEXT) {
      setNotice("QR found, but its hidden payload could not be read. Move closer or choose a clearer image.");
      return;
    }
    if (!decodeSeal(text)) {
      setNotice(`Unverified QR content: ${text}`);
      return;
    }
    setNotice("");
    const captured = photoCollection.capture(text, frame, { replace: replaceImage });
    collection.add(text);
    return captured;
  }, [photoCollection, collection]);

  useEffect(() => {
    collection.verify(publicKey);
    return () => collection.cancel();
  }, [collection, seals, publicKey]);

  return { ...snapshot, publicKey, setPublicKey, notice, setNotice, addSeal, scanImages,
    clear: () => { photoCollection.clear(); collection.clear(); setNotice(""); } };
}

export function SealVerification({ verification }) {
  const [openingKey, setOpeningKey] = useState(false);
  const [keyFileStatus, setKeyFileStatus] = useState("");
  const imageRead = useRef(0);
  useEffect(() => {
    imageRead.current += 1;
    return () => { imageRead.current += 1; };
  }, [verification.session]);
  const { seals, setPublicKey, results, notice, setNotice, busy, addSeal } = verification;
  const hasLocalSeals = seals.some(seal => decodeSeal(seal)?.version === "3");

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
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    const request = ++imageRead.current;
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (request !== imageRead.current) return;
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      // A single photographed sheet can contain four adjacent watermark
      // chunks. Recover them all without asking the user to upload the same
      // image four times. Keep the page photo once for later comparison.
      const aligned = scanPageAlignedImage(pixels);
      if (request !== imageRead.current) return;
      if (aligned.length) {
        aligned.forEach(({ seal }, index) => addSeal(seal, index === 0 ? canvas : null));
        return;
      }
      const code = scanQrImage(pixels.data, pixels.width, pixels.height);
      if (!code) throw new Error("No readable QR seal found. Include the entire page against a contrasting background, or choose a clear close-up of an older QR seal.");
      addSeal(qredPayloadFromPhotoScanResult(pixels.data, pixels.width, pixels.height, code), canvas);
    } catch (error) {
      if (request === imageRead.current) setNotice(error.message);
    } finally {
      URL.revokeObjectURL(url);
      input.value = "";
    }
  }

  return <section className="verification-card" aria-label="Seal verification">
    <h2>Verify collected seals</h2>
    <p>Include the whole printed page to recover one or four pale watermark codes at once. You can also scan older individual QR seals. Keep the page photo for comparison with its signed contents.</p>
    <p className="verification-note">PDFs, QR images, and camera frames are processed in this browser and are not sent to a server.</p>
    <details>
      <summary>Optional: use airplane mode</summary>
      <p>Load QRed, then enable airplane mode and turn Wi-Fi and Bluetooth off in your device settings to limit network access while you work. Keep this tab open.</p>
      <p>Try your workflow with a non-sensitive file before opening sensitive documents. Some PDF fonts and text-recognition resources may still need an internet connection.</p>
    </details>
    {hasLocalSeals && <div>
      <p>This collection includes a seal made with a private key file. Use the issuer’s public key file to verify it.</p>
      <label htmlFor="issuer-public-key-file">Open issuer public key file</label>
      <input id="issuer-public-key-file" type="file" accept=".txt,text/plain" onChange={openPublicKeyFile} disabled={openingKey} />
      <p role="status">{keyFileStatus}</p>
      <p className="verification-note">Obtain the key from the issuer through a trusted channel. The default demo key is public test data and proves no issuer identity.</p>
    </div>}
    <label htmlFor="qr-image">Choose QR image</label>
    <input id="qr-image" type="file" accept="image/*" onChange={readImage} />
    <PdfSealInput onSeal={addSeal} session={verification.session} />
    <button type="button" onClick={verification.clear}>Clear collected seals</button>
    <div aria-live="polite">
      {verification.progress && <p className="collection-progress">{verification.progress.message}</p>}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">Verifying…</p>}
      {results.map((result, index) => <article key={result.document_id || index} className="verification-result">
        <h3>{result.status}</h3>
        <p>Document: {result.document_id}</p>
        {result.identity && <>
          <p>{result.identity_authenticated ? "Account authenticated through " + authProvider(result.identity.provider)?.label : "Unverified identity claim"}: {result.identity.email}. Name: {result.identity.name} ({result.identity.name_source === result.identity.provider ? authProvider(result.identity.provider)?.label + " profile" : "self-declared"}).</p>
          {result.identity.provider !== "google" && <p>Email reported by {authProvider(result.identity.provider)?.label}; QRed did not separately verify control of that mailbox.</p>}
        </>}
        {result.timestamp && <p>{result.metadata_authenticated ? "Seal time" : "Claimed seal time"} ({result.attestation ? "QRed server clock" : "signer’s clock"}): <time dateTime={result.timestamp}>{result.timestamp}</time></p>}
        {result.key_id && <p>Key ID: {result.key_id}</p>}
        {result.pdf && <p>Page {result.page_number} of {result.page_count}</p>}
        {result.document_root && <p>Document fingerprint: {result.document_root}</p>}
        {result.error_message && <p>{result.error_message}</p>}
        {result.status === "INCOMPLETE" && <p>{result.collected_chunks} of {result.total_chunks} seals collected. Scan the remaining seals.</p>}
        {result.content && <pre>{result.content}</pre>}
      </article>)}
    </div>
    <PhotoTextVerification results={results} session={verification.session}
      scanPhotos={verification.scanImages?.photos} captureNotice={verification.scanImages?.notice}
      collecting={Boolean(verification.progress && !verification.progress.finished)} />
  </section>;
}
