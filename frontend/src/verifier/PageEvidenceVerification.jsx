/* eslint-disable no-unused-vars */
import React, { useEffect, useId, useRef, useState } from "react";
import { renderVisualReference } from "../pageEvidence.js";
import { openPagePhoto, photoPreviewUrl } from "./photoOcr.js";

function EvidencePage({ page, captures }) {
  const { evidence } = page;
  const id = useId(), canvas = useRef(null), generation = useRef(0), currentUrl = useRef(null);
  // A user-selected full-page photo must win over a QR-only scan captured
  // asynchronously. Scan snapshots can finish well after signature validation.
  const explicitPhoto = useRef(false);
  const [line, setLine] = useState(-1), [photo, setPhoto] = useState(null), [error, setError] = useState("");
  const [captureId, setCaptureId] = useState("");
  const firstCapture = captures[0];
  const lines = evidence.text.split("\n").filter(text => text.trim());
  const position = evidence.layout?.lines[line];
  useEffect(() => {
    if (!evidence.visual || !canvas.current) return;
    const image = renderVisualReference(evidence.visual);
    const context = canvas.current.getContext("2d");
    const pixels = context.createImageData(image.width, image.height);
    pixels.data.set(image.data);
    context.putImageData(pixels, 0, 0);
  }, [evidence.visual]);
  useEffect(() => {
    // The initial QR snapshot is only a starting point for comparison. Never
    // replace a full-page photo the user intentionally opened, even when a
    // delayed scanner snapshot arrives or another capture is collected.
    if (explicitPhoto.current) return;
    if (firstCapture) loadPhoto(firstCapture.file, firstCapture.id);
    else {
      generation.current++;
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
      currentUrl.current = null;
      setPhoto(null); setCaptureId("");
    }
  }, [firstCapture?.id]);
  useEffect(() => () => {
    generation.current++;
    if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
    currentUrl.current = null;
  }, []);
  async function loadPhoto(file, selectedCapture = "") {
    const token = ++generation.current;
    setError(""); setCaptureId(selectedCapture); setPhoto(null);
    try {
      const image = await openPagePhoto(file), url = await photoPreviewUrl(image);
      if (token !== generation.current) { URL.revokeObjectURL(url); return; }
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
      currentUrl.current = url; setPhoto(url);
    } catch (cause) { if (token === generation.current) setError(cause.message); }
  }
  function choose(event) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (file) {
      explicitPhoto.current = true;
      loadPhoto(file);
    }
  }
  return <>
    {evidence.blank ? <p className="photo-summary">The signer recorded this page as blank. Check the printed page for added marks.</p> : <p className="photo-note">
      The signature authenticates this stored reference. It is a lossy grayscale reconstruction, not a full image of the original.
      Small changes, colors, digits, and face substitutions may be lost. Compare important details using the signed text or the original document.
    </p>}
    <div className="evidence-comparison">
      <figure>
        <figcaption>{evidence.blank ? "Signed blank-page reference" : "Signed page reference"}</figcaption>
        <div className="evidence-reference" style={{ aspectRatio: `${evidence.width} / ${evidence.height}` }}>
          {evidence.visual && <canvas ref={canvas} width={evidence.visual.columns * 4} height={evidence.visual.rows * 4}
            role="img" aria-label="Signed grayscale visual reference" />}
          {evidence.blank && <span>Blank page</span>}
          {!evidence.blank && !evidence.visual && <span>Line locations only</span>}
          {position && <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Signed line location">
            <rect x={position.x} y={position.y} width={Math.max(1 / 256, position.width ?? 1 / 256)}
              height={Math.max(1 / 256, position.height ?? 1 / 256)} />
          </svg>}
        </div>
        {evidence.visual && <p className="photo-note">{evidence.visual.columns * 4} × {evidence.visual.rows * 4} pixels, reconstructed from the seal.</p>}
      </figure>
      <figure><figcaption>Page photo for comparison</figcaption>
        {photo ? <img className="evidence-photo" src={photo} alt="Page photo beside the signed visual reference" />
          : <p>Scan images appear here when available. Take or choose a photo of the entire page.</p>}
      </figure>
    </div>
    <p className="photo-note">A successful QR scan may show only part of the page. Use a clear photo of the entire printed page for comparison.</p>
    {evidence.layout && <>
      <label htmlFor={`${id}-line`}>Locate signed text</label>
      <select id={`${id}-line`} value={line} onChange={event => setLine(Number(event.target.value))}>
        <option value="-1">Choose a line to highlight on the reference</option>
        {lines.map((text, index) => <option key={index} value={index}>{index + 1}: {text.slice(0, 100)}</option>)}
      </select>
      {line >= 0 && <p className="photo-selected">{lines[line]}</p>}
      <p className="photo-note">{evidence.layout.mode === 1 ? "Locations use a coarse 16 × 16 grid." : evidence.layout.mode === 2 ? "Locations mark approximate line starts." : "Boxes mark the extracted text lines."} Positions refer to the original page, before the seal footer was added.</p>
    </>}
    {captures.length > 1 && <><label htmlFor={`${id}-capture`}>Visual comparison scan image</label>
      <select id={`${id}-capture`} value={captureId} onChange={event => {
        const capture = captures.find(item => String(item.id) === event.target.value);
        if (capture) {
          explicitPhoto.current = true;
          loadPhoto(capture.file, capture.id);
        }
      }}><option value="" disabled>Uploaded photo</option>{captures.map(capture => <option key={capture.id} value={capture.id}>Scan of seal {capture.chunkNumber + 1}</option>)}</select></>}
    <div className="photo-inputs">
      <div><label htmlFor={`${id}-camera`}>Take visual comparison photo</label><input id={`${id}-camera`} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={choose} /></div>
      <div><label htmlFor={`${id}-photo`}>Choose visual comparison photo</label><input id={`${id}-photo`} type="file" accept="image/jpeg,image/png,image/webp" onChange={choose} /></div>
    </div>
    <p className="photo-note">Compare these views yourself; QRed does not give an automatic image-match verdict. Photos stay on this device. No text-recognition download is needed for this view.</p>
    {error && <p role="alert">{error}</p>}
  </>;
}

export function PageEvidenceVerification({ results = [], scanPhotos = [], session = 0 }) {
  const id = useId(), [selected, setSelected] = useState("");
  const pages = results.filter(result => result.status === "VALID" && result.signature_valid === true && result.evidence)
    .sort((a, b) => (a.page_number || 0) - (b.page_number || 0));
  const page = pages.find(result => result.document_id === selected) || pages[0];
  if (!page) return null;
  const captures = scanPhotos.filter(capture => capture.documentId === page.document_id);
  return <section className="photo-check" aria-label="Signed page reference">
    <h2>Signed page reference</h2>
    <label htmlFor={`${id}-page`}>Reference page</label>
    <select id={`${id}-page`} value={page.document_id} onChange={event => setSelected(event.target.value)}>
      {pages.map(result => <option key={result.document_id} value={result.document_id}>Page {result.page_number} of {result.page_count}</option>)}
    </select>
    <EvidencePage key={`${session}:${page.document_id}:${page.key_id}:${page.page_hash}`} page={page} captures={captures} />
  </section>;
}
