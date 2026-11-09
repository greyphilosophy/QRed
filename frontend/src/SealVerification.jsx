import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { preparePhotoScanner, scanPhotoInWorker } from "./qr/photoScanClient.js";
import { readCameraPhotoFile, cameraCaptureFeedback } from "./qr/cameraPhoto.js";
import { decodeSeal } from "./qredVerifier.js";
import { isQRedEntryLink } from "./qr/qrPayload.js";
import { readSigningKeyFile } from "./signingKeys.js";
import { createVerificationSession } from "./verifier/verificationSession.js";
import { createPageTextChecks } from "./verifier/pageTextChecks.js";
import { PhotoTextVerification } from "./verifier/PhotoTextVerification.jsx";
import { createScanPhotoCollection } from "./verifier/scanPhotos.js";
import { PdfSealInput } from "./verifier/PdfSealInput.jsx";
import { authProvider } from "./authProviders.js";
import { PhotoScanProgress, usePhotoScanProgress } from "./qr/PhotoScanProgress.jsx";

export function useSealVerification() {
  const [collection] = useState(createVerificationSession);
  const [textChecks] = useState(createPageTextChecks);
  const [scanning, setScanning] = useState(false);
  const snapshot = useSyncExternalStore(collection.subscribe, collection.getSnapshot);
  const { seals } = snapshot;
  const [publicKey, setPublicKey] = useState("");
  const [notice, setNotice] = useState("");
  const [scanImages, setScanImages] = useState({ photos: [], notice: "" });
  const [photoCollection] = useState(() => createScanPhotoCollection(setScanImages));
  useEffect(() => () => { photoCollection.clear(); textChecks.dispose(); }, [photoCollection, textChecks]);
  const clear = useCallback(() => {
    textChecks.clear(); photoCollection.clear(); collection.clear();
    setNotice("Check cleared. Camera off."); setScanning(false);
  }, [textChecks, photoCollection, collection]);
  useEffect(() => {
    // Also clear a page restored from the back/forward cache.
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, [clear]);

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

  const addSeal = useCallback((text, frame, { replaceImage = false, originalPage = false } = {}) => {
    if (collection.getSnapshot().session !== snapshot.session) return;
    if (isQRedEntryLink(text)) {
      setNotice("That code opens qred.org. Scan the pale watermark to read the document seal.");
      return;
    }
    if (!decodeSeal(text)) {
      setNotice(`Unverified QR content: ${text}`);
      return;
    }
    setNotice("");
    const captured = photoCollection.capture(text, frame, { replace: replaceImage, originalPage });
    collection.add(text);
    return captured;
  }, [photoCollection, collection, snapshot.session]);

  useEffect(() => {
    collection.verify(publicKey);
    return () => collection.cancel();
  }, [collection, seals, publicKey]);

  return { ...snapshot, publicKey, setPublicKey, notice, setNotice, addSeal, scanImages,
    scanning, setScanning, textChecks, clear,
    replacePhoto: (id, file) => {
      if (collection.getSnapshot().session === snapshot.session) photoCollection.replacePage(id, file);
    } };
}

export function SealVerification({ verification }) {
  const [openingKey, setOpeningKey] = useState(false);
  const [keyFileStatus, setKeyFileStatus] = useState("");
  const [readingImage, setReadingImage] = useState(false);
  const [imageAttempt, setImageAttempt] = useState(0);
  const imageRead = useRef(0);
  const imageScan = useRef(null);
  const photoProgressRegion = useRef(null);
  const photoProgress = usePhotoScanProgress();
  useEffect(() => {
    // The real file picker scrolls to the input inside the lower disclosure.
    // Bring its status and Cancel back into view once, not on clock ticks.
    if (readingImage) photoProgressRegion.current?.scrollIntoView?.({ block: "nearest" });
  }, [readingImage, imageAttempt]);
  useEffect(() => { preparePhotoScanner(); }, []);
  useEffect(() => {
    imageRead.current += 1;
    photoProgress.clear();
    setReadingImage(false); setKeyFileStatus("");
    return () => { imageRead.current += 1; imageScan.current?.abort(); };
  }, [verification.session, photoProgress]);
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
    input.value = "";
    imageScan.current?.abort();
    const controller = new AbortController();
    imageScan.current = controller;
    const request = ++imageRead.current;
    setImageAttempt(request);
    const progress = photoProgress.begin("opening");
    let canvas;
    setReadingImage(true);
    setNotice("");
    try {
      canvas = document.createElement("canvas");
      let captureDiagnostic = null;
      // The homepage camera's Choose photo button uses this same input. Keep
      // its working pixels bounded like standalone/retake file selection,
      // without imposing a full-page resolution floor on ordinary QR images.
      const pixels = await readCameraPhotoFile(file, canvas, {
        signal: controller.signal, requireHighResolution: false,
        onDiagnostic: diagnostic => { captureDiagnostic = diagnostic; },
      });
      if (request !== imageRead.current) return;
      if (!pixels) throw new Error("This photo could not be opened at a usable size. Choose another photo.");
      progress.phase("decoding");
      // A single photographed sheet can contain four adjacent watermark
      // chunks. Recover them all without asking the user to upload the same
      // image four times. Keep the page photo once for later comparison.
      const action = cameraCaptureFeedback(
        await scanPhotoInWorker(pixels, { returnPayload: true, signal: controller.signal, onStage: progress.stage }), captureDiagnostic);
      if (request !== imageRead.current) return;
      if (action.status === "found-multiple") action.texts.forEach((seal, index) => addSeal(seal, index === 0 ? canvas : null));
      else if (action.status === "found") addSeal(action.text, canvas);
      else setNotice(action.message || "No readable seal found. Try another photo.");
      // A timeout can retain useful chunks without completing the page.
      // Set this after collection, which clears notices when adding a seal.
      if (action.timedOut && action.message) setNotice(action.message);
    } catch (error) {
      if (request === imageRead.current && error.name !== "AbortError") setNotice(error.message);
    } finally {
      progress.stop();
      if (canvas) canvas.width = canvas.height = 0;
      if (request === imageRead.current) { imageScan.current = null; setReadingImage(false); }
    }
  }

  function cancelImageScan() {
    imageRead.current += 1;
    imageScan.current?.abort();
    imageScan.current = null;
    photoProgress.clear();
    setReadingImage(false);
    setNotice("Photo scan cancelled.");
  }

  return <section className="verification-card" aria-label="Seal verification" id="document-check">
    <div className="verification-actions"><button type="button" onClick={verification.clear}>Finish &amp; clear</button></div>
    {readingImage && <div ref={photoProgressRegion}>
      <PhotoScanProgress progress={photoProgress} />
      <button type="button" onClick={cancelImageScan}>Cancel photo scan</button>
    </div>}
    {notice && notice !== "Check cleared. Camera off." && <p role="status">{notice}</p>}
    <PhotoTextVerification results={results} seals={seals} session={verification.session} checks={verification.textChecks}
      scanPhotos={verification.scanImages?.photos} captureNotice={verification.scanImages?.notice}
      collectionProgress={verification.progress}
      scanning={verification.scanning} verifying={busy} onReplacePhoto={verification.replacePhoto} />
    {hasLocalSeals && <div>
      <p>This collection includes a seal made with a private key file. Use the issuer’s public key file to verify it.</p>
      <label htmlFor="issuer-public-key-file">Open issuer public key file</label>
      <input id="issuer-public-key-file" type="file" accept=".txt,text/plain" onChange={openPublicKeyFile} disabled={openingKey} />
      <p role="status">{keyFileStatus}</p>
      <p className="verification-note">Obtain the key from the issuer through a trusted channel. The default demo key is public test data and proves no issuer identity.</p>
    </div>}
    <details className="verification-details"><summary>Open an existing PDF or image</summary>
    <p className="verification-note">PDFs, QR images, and camera frames are processed in this browser and are not sent to a server.</p>
    <details>
      <summary>Optional: use airplane mode</summary>
      <p>Load QRed, then enable airplane mode and turn Wi-Fi and Bluetooth off in your device settings to limit network access while you work. Keep this tab open.</p>
      <p>Try your workflow with a non-sensitive file before opening sensitive documents. Some PDF fonts and text-recognition resources may still need an internet connection.</p>
    </details>
    <label htmlFor="qr-image">Choose QR image</label>
    <input id="qr-image" type="file" accept="image/*" onChange={readImage} />
    <PdfSealInput onSeal={addSeal} session={verification.session} />
    </details>
    <details className="verification-details"><summary>Seal details and recovered text</summary>
    <div aria-live="polite">
      {verification.progress && <p className="collection-progress">{verification.progress.message}</p>}
      {busy && <p role="status">Verifying…</p>}
      {results.map((result, index) => <article key={result.document_id || index} className="verification-result">
        <h3>{result.status === "VALID" ? "Seal authenticated" : result.status}</h3>
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
    </details>
  </section>;
}
