/* eslint-disable no-unused-vars */
import React, { useEffect, useId, useRef, useState } from "react";
import { comparePhotoText } from "./photoTextComparison.js";
import { createPhotoOcrReader, openPagePhoto, photoPreviewUrl } from "./photoOcr.js";
import "./photoTextVerification.css";

const messages = {
  matches: "Recognized text matches the signed text",
  uncertain: "Text agrees, but some readings need review",
  differences: "Differences found — review the marked text",
  unreadable: "No text could be read — try a clearer photo",
};
const wordLabels = { matched: "Matching text", different: "Different or extra text", uncertain: "Uncertain reading" };

export function PhotoTextVerification({ results = [], session = 0 }) {
  const id = useId();
  const [reader] = useState(() => createPhotoOcrReader());
  const [selectedId, setSelectedId] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [photo, setPhoto] = useState(null);
  const [comparison, setComparison] = useState(null);
  const [selectedWord, setSelectedWord] = useState(null);
  const [highlights, setHighlights] = useState(true);
  const [zoom, setZoom] = useState(1);
  const run = useRef(0);
  const working = useRef(false);
  const currentPhoto = useRef(null);
  const pages = results.filter(result => result.status === "VALID" && result.signature_valid === true && result.content?.trim());
  const page = pages.find(result => result.document_id === selectedId) || pages[0];
  const pageIdentity = page ? `${page.document_id}:${page.key_id}:${page.page_number || 0}` : "";

  function cancel() {
    run.current += 1;
    if (working.current) { reader.dispose(); setReady(false); }
    working.current = false;
    setBusy(false);
    setStatus("");
  }
  function clearPhoto() {
    cancel();
    if (currentPhoto.current) URL.revokeObjectURL(currentPhoto.current.url);
    currentPhoto.current = null;
    setPhoto(null); setComparison(null); setSelectedWord(null); setError(""); setZoom(1);
  }
  useEffect(() => { clearPhoto(); }, [pageIdentity, page?.content, session]);
  useEffect(() => () => {
    run.current += 1;
    reader.dispose();
    if (currentPhoto.current) URL.revokeObjectURL(currentPhoto.current.url);
  }, [reader]);

  function begin() {
    const token = ++run.current;
    working.current = true;
    setBusy(true); setError(""); setComparison(null); setSelectedWord(null);
    return token;
  }
  function progress(token, event) {
    if (run.current !== token) return;
    const percent = Math.round((event.progress || 0) * 100);
    setStatus(event.status === "recognizing text" ? `Reading page text… ${percent}%` : "Loading text recognition on this device…");
  }
  function fail(token, cause) {
    if (run.current !== token) return;
    reader.dispose(); setReady(false);
    setComparison(null); setStatus("");
    setError(`Photo comparison could not finish. ${cause?.message || String(cause)} Load text recognition while connected, then try a clear, upright photo.`);
  }
  function finish(token) {
    if (run.current !== token) return;
    working.current = false; setBusy(false);
  }
  async function prepare() {
    const token = begin();
    setStatus("Loading text recognition on this device…");
    try {
      await reader.prepare(event => progress(token, event));
      if (run.current !== token) return;
      setReady(true); setStatus("Text recognition is ready. You can now use airplane mode while keeping this tab open.");
    } catch (cause) { fail(token, cause); }
    finally { finish(token); }
  }
  async function compare(canvas, token, expectedText) {
    setStatus("Reading page text…");
    const words = await reader.read(canvas, event => progress(token, event));
    if (run.current !== token) return;
    setComparison(comparePhotoText(expectedText, words, canvas));
    setStatus("");
  }
  async function showPhoto(canvas, token) {
    const url = await photoPreviewUrl(canvas);
    if (run.current !== token) { URL.revokeObjectURL(url); return false; }
    if (currentPhoto.current) URL.revokeObjectURL(currentPhoto.current.url);
    const next = { canvas, url };
    currentPhoto.current = next;
    setPhoto(next); setZoom(1);
    return true;
  }
  async function choosePhoto(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !page || !ready) return;
    clearPhoto();
    const token = begin(), expectedText = page.content;
    setStatus("Opening page photo on this device…");
    try {
      const canvas = await openPagePhoto(file);
      if (!await showPhoto(canvas, token)) return;
      await compare(canvas, token, expectedText);
    } catch (cause) { fail(token, cause); }
    finally { finish(token); }
  }
  async function readAgain(rotate = false) {
    if (!photo || !page || !ready) return;
    const token = begin(), expectedText = page.content;
    try {
      let canvas = photo.canvas;
      if (rotate) {
        canvas = document.createElement("canvas");
        canvas.width = photo.canvas.height; canvas.height = photo.canvas.width;
        const context = canvas.getContext("2d");
        context.translate(canvas.width, 0); context.rotate(Math.PI / 2);
        context.drawImage(photo.canvas, 0, 0);
        if (!await showPhoto(canvas, token)) return;
      }
      await compare(canvas, token, expectedText);
    } catch (cause) { fail(token, cause); }
    finally { finish(token); }
  }

  return <section className="photo-check" aria-label="Compare a page photo">
    <h2>Compare a page photo</h2>
    <p>Read the printed text and mark differences against a verified seal. Photos are processed on this device and are not sent to a server.</p>
    <p className="photo-note">For printed English text. Photograph the entire page upright, in good light. Photos, handwriting, and the original page layout are not authenticated by this check.</p>
    <div className="photo-actions">
      <button type="button" onClick={prepare} disabled={busy || ready}>{ready ? "Text recognition ready" : "Load text recognition"}</button>
      {busy && <button type="button" onClick={cancel}>Cancel reading</button>}
    </div>
    {!ready && <p className="photo-note">Load text recognition before going offline. This loads the reader and its English language data from QRed.</p>}
    {!page ? <p>Verify all QR seals for a page to enable photo comparison.</p> : <>
      <label htmlFor={`${id}-page`}>Signed page to compare</label>
      <select id={`${id}-page`} value={page.document_id} onChange={event => setSelectedId(event.target.value)}>
        {pages.map(result => <option key={result.document_id} value={result.document_id}>
          {result.pdf ? `Page ${result.page_number} of ${result.page_count}` : "Signed text"} — {result.document_id.slice(0, 12)}
        </option>)}
      </select>
      <div className="photo-inputs">
        <div><label htmlFor={`${id}-camera`}>Take page photo</label>
          <input id={`${id}-camera`} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={choosePhoto} disabled={!ready || busy} /></div>
        <div><label htmlFor={`${id}-file`}>Choose page photo</label>
          <input id={`${id}-file`} type="file" accept="image/jpeg,image/png,image/webp" onChange={choosePhoto} disabled={!ready || busy} /></div>
      </div>
    </>}
    <div role="status" aria-live="polite">{status}{comparison && <p className={`photo-summary ${comparison.status}`}>{messages[comparison.status]}</p>}</div>
    {error && <p role="alert">{error}</p>}
    {photo && <>
      <div className="photo-actions">
        <button type="button" onClick={() => readAgain(true)} disabled={busy || !ready}>Rotate photo</button>
        <button type="button" onClick={() => readAgain()} disabled={busy || !ready}>Read photo again</button>
        <button type="button" onClick={clearPhoto}>Clear photo</button>
        <label className="photo-inline"><input type="checkbox" checked={highlights} onChange={event => setHighlights(event.target.checked)} />Show highlights</label>
        <label className="photo-inline" htmlFor={`${id}-zoom`}>Zoom
          <select id={`${id}-zoom`} value={zoom} onChange={event => setZoom(Number(event.target.value))}><option value="1">100%</option><option value="2">200%</option><option value="3">300%</option></select>
        </label>
      </div>
      {comparison && <ul className="photo-legend">
        <li className="matched">Matching: {comparison.matchedCount}</li>
        <li className="different">Different or extra: {comparison.differentCount}</li>
        <li className="uncertain">Uncertain: {comparison.uncertainCount}</li>
      </ul>}
      <div className="photo-scroll">
        <div className="photo-stage" style={{ width: `${zoom * 100}%` }}>
          <img src={photo.url} alt="Page photo being compared with signed text" />
          {highlights && comparison && <svg viewBox={`0 0 ${photo.canvas.width} ${photo.canvas.height}`} aria-label="Text comparison highlights">
            {comparison.words.map((word, index) => word.bbox && <rect key={index} className={`photo-word ${word.status}`}
              x={word.bbox.x0} y={word.bbox.y0} width={word.bbox.x1 - word.bbox.x0} height={word.bbox.y1 - word.bbox.y0}
              role="button" tabIndex={0} aria-label={`${wordLabels[word.status]}: ${word.text}`}
              onClick={() => setSelectedWord(word)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedWord(word); } }}>
              <title>{wordLabels[word.status]}: {word.text}</title>
            </rect>)}
          </svg>}
        </div>
      </div>
      {selectedWord && <p className="photo-selected" role="status">{wordLabels[selectedWord.status]}: <strong>{selectedWord.text}</strong></p>}
      {comparison && <>
        <p className="photo-note">Highlights describe what OCR read, not a guarantee that every mark on the page was read correctly. Check important numbers and unmarked areas. Reading order, blur, and seal captions can cause differences.</p>
        {comparison.differences.length > 0 && <div className="photo-differences">
          <h3>Text to review</h3>
          <p>Missing text has no reliable photo location because seals do not store word positions.</p>
          <ol>{comparison.differences.map((difference, index) => <li key={index}>
            <div><strong>Signed text not matched:</strong> {difference.expected || "(none — additional text was read)"}</div>
            <div><strong>Photo reading nearby:</strong> {difference.observed || "(not read in the photo)"}</div>
          </li>)}</ol>
        </div>}
      </>}
    </>}
  </section>;
}
