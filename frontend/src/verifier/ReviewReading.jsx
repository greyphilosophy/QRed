import React, { useEffect, useId, useRef, useState } from "react";
import { changedCharacters, findingBoxes, REVIEW_DECISIONS } from "./reviewFindings.js";
import { ImageZoom } from "./ImageZoom.jsx";

const INSPECTION_DECISIONS = { matches: "No discrepancy seen", differs: "Concern found", unsure: "Can't tell" };

export function ReviewReading({ page, item, decision, onDecision, onEnlarge }) {
  const { difference: d } = item;
  const parts = changedCharacters(d.expected, d.observed);
  const choices = item.inspection ? INSPECTION_DECISIONS : REVIEW_DECISIONS;
  const contextAt = d.expected && d.context?.indexOf(d.expected);
  const uniqueContext = contextAt >= 0 && contextAt === d.context?.lastIndexOf(d.expected);
  return <li className={`review-reading ${decision || "pending"}`}>
    <p className="review-reason">{item.reason}</p>
    {!item.inspection && <div className="review-wording"><strong>Signed text:</strong>{" "}
      <ChangedText parts={parts.expected} empty="(no text here)" /></div>}
    {d.observed !== undefined && <div className="review-wording"><strong>Photo reading:</strong>{" "}
      <ChangedText parts={parts.observed} empty="(not read — inspect for missing text)" /></div>}
    {item.inspection && item.notes[0] && <p className="photo-note">{item.notes[0]}</p>}
    {item.readings && <div className="review-rereads">{item.readings.map(reading =>
      <div key={reading.label}><strong>{reading.label}:</strong> {reading.text}</div>)}</div>}
    <DifferenceCrop page={page} difference={d} decision={decision} onEnlarge={onEnlarge} />
    {d.context && d.context !== d.expected && <details className="review-context"><summary>Nearby signed text</summary>
      <p>{uniqueContext ? <>{d.context.slice(0, contextAt)}<mark>{d.expected}</mark>{d.context.slice(contextAt + d.expected.length)}</> : d.context}</p>
    </details>}
    {(d.sourceReading || d.review === "firstReading" || item.notes.length > (item.inspection ? 1 : 0)) &&
      <details className="review-context"><summary>Why this needs checking</summary>
        {d.sourceReading && <p>Before sealing, OCR read this line as <strong>{d.sourceReading}</strong>.</p>}
        {d.review === "firstReading" && <p>The first reading found this wording in the same place. Check the original photo to resolve the disagreement.</p>}
        {item.notes.slice(item.inspection ? 1 : 0).map((note, index) => <p key={index}>{note}</p>)}
      </details>}
    {item.inspection && !d.expected && <details className="review-context"><summary>Signed page text</summary>
      <p className="review-reference">{page.page.content}</p></details>}
    <fieldset className="review-decisions"><legend>Your decision</legend>
      <div>{Object.entries(choices).map(([value, label]) => <button type="button" key={value}
        className={`review-choice ${value}`} aria-pressed={decision === value}
        onClick={() => onDecision(decision === value ? undefined : value)}>{label}</button>)}</div>
    </fieldset>
    <span className="sr-only" role="status">{decision ? `Recorded: ${choices[decision]}. Select again to clear.` : "No decision recorded."}</span>
  </li>;
}

function ChangedText({ parts, empty }) {
  return <span className="review-text">{parts.length ? parts.map((part, index) => part.changed
    ? <mark className="text-change" key={index}>{part.text}</mark> : <React.Fragment key={index}>{part.text}</React.Fragment>) : empty}</span>;
}

export function cropBounds(page, boxes) {
  if (!boxes.length) return { left: 0, top: 0, width: page.width, height: page.height };
  const left = Math.max(0, Math.min(...boxes.map(box => box.x0)) - 70);
  const top = Math.max(0, Math.min(...boxes.map(box => box.y0)) - 24);
  return { left, top,
    width: Math.min(page.width - left, Math.max(...boxes.map(box => box.x1)) - left + 70),
    height: Math.min(page.height - top, Math.max(...boxes.map(box => box.y1)) - top + 24) };
}

function LocationMarks({ boxes, tone, halo = false }) {
  return boxes.map((box, index) => <g key={index}>
    {halo && <rect x={box.x0} y={box.y0} width={box.x1 - box.x0} height={box.y1 - box.y0} className="difference-location-halo" />}
    <rect x={box.x0} y={box.y0} width={box.x1 - box.x0} height={box.y1 - box.y0}
      className={`${halo ? "difference-location-mark" : "photo-word"} ${tone}`} />
  </g>);
}

export function DifferenceCrop({ page, difference, decision, onEnlarge }) {
  const boxes = findingBoxes(difference, page.comparison);
  const tone = decision === "differs" ? "different" : decision === "matches" ? "matched" : "uncertain";
  const bounds = cropBounds(page, boxes);
  if (!page.url) return null;
  if (!boxes.length) return <div className="review-no-location"><p className="photo-note">No reliable photo location. Inspect the signed wording and nearby text on the full page.</p>
    {onEnlarge && <button type="button" onClick={event => onEnlarge("page", event.currentTarget)}>Inspect full page</button>}</div>;
  const wrap = (mode, label, image) => onEnlarge
    ? <button type="button" className="review-image-button" aria-label={label} onClick={event => onEnlarge(mode, event.currentTarget)}>{image}<span className="review-enlarge-mark" aria-hidden="true">+</span></button>
    : image;
  return <div className="difference-visuals">
    <figure>{wrap("page", "Enlarge page location", <svg className="difference-thumbnail"
      viewBox={`0 0 ${page.width} ${page.height}`} role="img" aria-label="Page thumbnail showing text location">
      <image href={page.url} width={page.width} height={page.height} />
      <LocationMarks boxes={boxes} tone={tone} halo />
    </svg>)}<figcaption>On page</figcaption></figure>
    <figure>{wrap("detail", "Enlarge close-up", <svg className="difference-crop"
      viewBox={`${bounds.left} ${bounds.top} ${bounds.width} ${bounds.height}`} role="img" aria-label="Magnified photo difference">
      <image href={page.url} width={page.width} height={page.height} />
      <LocationMarks boxes={boxes} tone={tone} />
    </svg>)}<figcaption>Close-up</figcaption></figure>
  </div>;
}

export function ReadingViewer({ page, item, decision, initialMode, opener, onClose }) {
  const dialog = useRef(null), scroll = useRef(null), stage = useRef(null), titleId = useId();
  const [mode, setMode] = useState(initialMode), [zoom, setZoom] = useState(1), [highlight, setHighlight] = useState(true);
  const boxes = findingBoxes(item?.difference || {}, page.comparison);
  const bounds = mode === "detail" ? cropBounds(page, boxes) : { left: 0, top: 0, width: page.width, height: page.height };
  const tone = decision === "differs" ? "different" : decision === "matches" ? "matched" : "uncertain";
  useEffect(() => {
    const node = dialog.current, previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    node.showModal();
    return () => { node.close(); document.body.style.overflow = previousOverflow; opener?.focus({ preventScroll: true }); };
  }, [opener]);
  useEffect(() => {
    const viewport = scroll.current, image = stage.current;
    if (!viewport || !image) return;
    const x = boxes.length ? (Math.min(...boxes.map(b => b.x0)) + Math.max(...boxes.map(b => b.x1))) / 2 : page.width / 2;
    const y = boxes.length ? (Math.min(...boxes.map(b => b.y0)) + Math.max(...boxes.map(b => b.y1))) / 2 : page.height / 2;
    viewport.scrollLeft = (x - bounds.left) / bounds.width * image.clientWidth - viewport.clientWidth / 2;
    viewport.scrollTop = (y - bounds.top) / bounds.height * image.clientHeight - viewport.clientHeight / 2;
  }, [mode, zoom]);
  return <dialog ref={dialog} className="reading-viewer" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
    <div className="reading-viewer-header"><h3 id={titleId}>{mode === "page" ? "Page location" : "Enlarged close-up"}</h3>
      <button type="button" onClick={onClose} autoFocus>Back to review</button></div>
    <div className="reading-viewer-tools">
      {boxes.length > 0 && <button type="button" onClick={() => { setMode(mode === "page" ? "detail" : "page"); setZoom(1); }}>
        {mode === "page" ? "Show close-up" : "Show full page"}</button>}
      <ImageZoom value={zoom} onChange={setZoom} />
      {boxes.length > 0 && <label><input type="checkbox" checked={highlight} onChange={event => setHighlight(event.target.checked)} />Show highlight</label>}
    </div>
    <div ref={scroll} className="reading-viewer-scroll"><svg ref={stage} role="img" aria-label="Original photo for visual review"
      viewBox={`${bounds.left} ${bounds.top} ${bounds.width} ${bounds.height}`}
      style={{ width: zoom === 1 ? `min(100%, calc(60svh * ${bounds.width / bounds.height}))` : `${zoom * 100}%` }}>
      <image href={page.url} width={page.width} height={page.height} />
      {highlight && <LocationMarks boxes={boxes} tone={tone} halo />}
    </svg></div>
    <p className="photo-note">{item?.reason || "Inspect the whole page"} · {page.page.pdf ? `Page ${page.page.page_number}` : "Signed text"}</p>
  </dialog>;
}
