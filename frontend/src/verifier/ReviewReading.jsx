import React, { useEffect, useId, useRef, useState } from "react";
import { changedCharacters, findingBoxes, sealedPassage, REVIEW_DECISIONS } from "./reviewFindings.js";
import { ImageZoom } from "./ImageZoom.jsx";

const INSPECTION_DECISIONS = { matches: "No discrepancy seen", differs: "Concern found", unsure: "Can't tell" };

export function ReviewReading({ page, item, decision, onDecision, onEnlarge }) {
  const { difference: d } = item;
  const parts = changedCharacters(d.expected, d.observed);
  const choices = item.inspection ? INSPECTION_DECISIONS : REVIEW_DECISIONS;
  const passage = sealedPassage(d, page.page.content);
  return <li className={`review-reading ${decision || "pending"}`}>
    <DifferenceCrop page={page} difference={d} decision={decision} onEnlarge={onEnlarge}>
      <div className="review-sealed-text">
        {!item.inspection ? <div className="review-wording"><strong>Sealed text:</strong>{" "}
          <span className="review-reference">{passage.before}<ChangedText parts={parts.expected}
            empty="(no corresponding text in the seal)" />{passage.after}</span></div>
          : <><p className="review-reason">{item.reason}</p>
            {item.notes[0] && <p className="photo-note">{item.notes[0]}</p>}
            {!d.expected && <details className="review-context"><summary>Sealed page text</summary>
              <p className="review-reference">{page.page.content}</p></details>}</>}
      </div>
    </DifferenceCrop>
    <fieldset className="review-decisions"><legend>{item.inspection ? "Your decision" : "Does the photo or paper match the sealed text?"}</legend>
      <div>{Object.entries(choices).map(([value, label]) => <button type="button" key={value}
        className={`review-choice ${value}`} aria-pressed={decision === value}
        onClick={() => onDecision(decision === value ? undefined : value)}>{label}</button>)}</div>
    </fieldset>
    <span className="sr-only" role="status">{decision ? `Recorded: ${choices[decision]}. Select again to clear.` : "No decision recorded."}</span>
    <details key={item.id} className="review-context review-machine-reading"><summary>Why this was flagged</summary>
      {!item.inspection && <><p className="review-reason">{item.reason}</p>
        <div className="review-wording"><strong>Flagged sealed text:</strong>{" "}
          <ChangedText parts={parts.expected} empty="(no corresponding text in the seal)" /></div></>}
      {d.observed !== undefined && <div className="review-wording"><strong>Photo reading:</strong>{" "}
        <ChangedText parts={parts.observed} empty="(not read — inspect for missing text)" /></div>}
      {item.readings && <div className="review-rereads">{item.readings.map(reading =>
        <div key={reading.label}><strong>{reading.label}:</strong> {reading.text}</div>)}</div>}
      {d.sourceReading && <p>Before sealing, OCR read this line as <strong>{d.sourceReading}</strong>.</p>}
      {d.review === "firstReading" && <p>The first reading found this wording in the same place. Check the original photo to resolve the disagreement.</p>}
      {item.notes.slice(item.inspection ? 1 : 0).map((note, index) => <p key={index}>{note}</p>)}
      {d.context && !passage.before && !passage.after && d.context !== d.expected &&
        <p className="review-reference"><strong>Nearby sealed text:</strong> {d.context}</p>}
    </details>
  </li>;
}

function ChangedText({ parts, empty }) {
  return <span className="review-text">{parts.length ? parts.map((part, index) => part.changed
    ? <mark className="text-change" key={index}>{part.text}</mark> : <React.Fragment key={index}>{part.text}</React.Fragment>) : empty}</span>;
}

export function cropBounds(page, boxes) {
  if (!boxes.length) return { left: 0, top: 0, width: page.width, height: page.height };
  // Include the photographed line, not just the changed word. These boxes only
  // widen the display; the selected markers and comparison stay unchanged.
  const neighboring = [...(page.comparison?.words || []), ...(page.comparison?.originalComparison?.words || [])]
    .map(word => word.bbox).filter(box => box && boxes.some(selected =>
      Math.min(box.y1, selected.y1) - Math.max(box.y0, selected.y0)
        >= Math.min(box.y1 - box.y0, selected.y1 - selected.y0) * .5));
  const contextBoxes = [...boxes, ...neighboring];
  // Keep neighboring lines visible on double-spaced pages and high-resolution
  // photos. Fixed pixel padding becomes almost invisible as resolution grows.
  const heights = contextBoxes.map(box => box.y1 - box.y0).sort((a, b) => a - b);
  const lineHeight = heights[Math.floor(heights.length / 2)];
  const horizontal = Math.max(page.width * .035, lineHeight * 2);
  const vertical = Math.max(page.height * .025, lineHeight * 4);
  const left = Math.max(0, Math.min(...contextBoxes.map(box => box.x0)) - horizontal);
  const top = Math.max(0, Math.min(...contextBoxes.map(box => box.y0)) - vertical);
  const right = Math.min(page.width, Math.max(...contextBoxes.map(box => box.x1)) + horizontal);
  const bottom = Math.min(page.height, Math.max(...contextBoxes.map(box => box.y1)) + vertical);
  return { left, top,
    width: right - left, height: bottom - top };
}

function LocationMarks({ boxes, tone, halo = false }) {
  return boxes.map((box, index) => <g key={index}>
    {halo && <rect x={box.x0} y={box.y0} width={box.x1 - box.x0} height={box.y1 - box.y0} className="difference-location-halo" />}
    <rect x={box.x0} y={box.y0} width={box.x1 - box.x0} height={box.y1 - box.y0}
      className={`${halo ? "difference-location-mark" : "photo-word"} ${tone}`} />
  </g>);
}

export function DifferenceCrop({ page, difference, decision, onEnlarge, children }) {
  const boxes = findingBoxes(difference, page.comparison);
  const tone = decision === "differs" ? "different" : decision === "matches" ? "matched" : "uncertain";
  const bounds = cropBounds(page, boxes);
  if (!page.url) return children || null;
  if (!boxes.length) return <div className="review-no-location">{children}<p className="photo-note">No reliable photo location. Inspect the sealed wording and nearby text on the full page.</p>
    {onEnlarge && <button type="button" onClick={event => onEnlarge("page", event.currentTarget)}>Inspect full page</button>}</div>;
  const wrap = (mode, label, image) => onEnlarge
    ? <button type="button" className="review-image-button" aria-label={label} onClick={event => onEnlarge(mode, event.currentTarget)}>{image}<span className="review-enlarge-mark" aria-hidden="true">+</span></button>
    : image;
  return <div className={`difference-visuals${children ? " with-reference" : ""}`}>
    <figure className="difference-location">{wrap("page", "Enlarge page location", <svg className="difference-thumbnail"
      viewBox={`0 0 ${page.width} ${page.height}`} role="img" aria-label="Page thumbnail showing text location">
      <image href={page.url} width={page.width} height={page.height} />
      <LocationMarks boxes={boxes} tone={tone} halo />
    </svg>)}<figcaption>On page</figcaption></figure>
    {children}
    <figure className="difference-detail">{wrap("detail", "Enlarge close-up", <svg className="difference-crop"
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
