/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PageEvidenceVerification } from "./PageEvidenceVerification.jsx";
import { PageCameraCapture } from "./PageCameraCapture.jsx";
import { createPageTextChecks } from "./pageTextChecks.js";
import { decodeSeal } from "../qredVerifier.js";
import { photoProcessingMessage } from "./photoStatus.js";
import "./photoTextVerification.css";

const EMPTY = [];
const labels = {
  missing: "Printed text not checked — capture the whole page",
  queued: "Printed text waiting to be checked",
  reading: "Reading printed text…",
  matches: "Recognized text matches the signed text",
  differences: "Differences found — review the marked text",
  uncertain: "Some readings need review",
  unreadable: "No text could be read — retake this page",
  error: "Text check could not finish — retry or retake",
};
const wordLabels = { matched: "Matching text", different: "Different or extra text", uncertain: "Uncertain reading" };
const pageName = page => page.pdf ? `Page ${page.page_number} of ${page.page_count}` : "Signed text";

export function PhotoTextVerification({ session = 0, ...props }) {
  return <PageChecks key={session} {...props} session={session} />;
}

function PageChecks({ results = EMPTY, seals = EMPTY, scanPhotos = EMPTY, captureNotice = "", scanning = false, verifying = false,
  checks: providedChecks, onReplacePhoto, collectionProgress, session }) {
  const [checks] = useState(() => providedChecks || createPageTextChecks());
  const snapshot = useSyncExternalStore(checks.subscribe, checks.getSnapshot);
  const [selected, setSelected] = useState(""), [retake, setRetake] = useState(null);
  const [showMatches, setShowMatches] = useState(false), [selectedWord, setSelectedWord] = useState(null);
  const [zoom, setZoom] = useState(1);
  const selectedByUser = useRef(false), openedPriority = useRef(0), heading = useRef(null), focusPage = useRef(null);
  useEffect(() => { checks.update(results, scanPhotos, { scanning, verifying }); }, [checks, results, scanPhotos, scanning, verifying]);
  useEffect(() => () => { if (!providedChecks) checks.dispose(); }, [checks, providedChecks]);
  const pages = snapshot.pages;
  const page = pages.find(item => item.id === selected) || pages[0];
  useEffect(() => {
    if (selectedByUser.current || scanning || verifying) return;
    const priority = item => item.state === "differences" ? 4 : ["unreadable", "error"].includes(item.state) ? 3
      : item.state === "uncertain" ? (item.comparison?.markings?.length || item.comparison?.contrastAssisted ? 1 : 2) : 0;
    const issue = [...pages].sort((a, b) => priority(b) - priority(a))[0];
    if (issue && priority(issue) > openedPriority.current) {
      focusPage.current = issue.id;
      openedPriority.current = priority(issue); setSelected(issue.id);
    }
  }, [pages, scanning, verifying]);
  useEffect(() => {
    if (focusPage.current !== page?.id || !heading.current) return;
    focusPage.current = null;
    heading.current.focus({ preventScroll: true });
    heading.current.scrollIntoView?.({ block: "start" });
  }, [page?.id, pages]);
  useEffect(() => { setSelectedWord(null); setZoom(1); }, [page?.id, page?.captureId]);
  const comparison = page?.comparison;
  const contentDifferences = comparison?.differences.filter(difference => !difference.typography && !difference.spacing && !difference.review) || [];
  const numbersToCheck = comparison?.differences.filter(difference => difference.review === "number") || [];
  const readingsToCheck = comparison?.differences.filter(difference => difference.review && difference.review !== "number") || [];
  const typographyDifferences = comparison?.differences.filter(difference => difference.typography) || [];
  const spacingDifferences = comparison?.differences.filter(difference => difference.spacing) || [];
  const difficultReading = comparison?.words.length >= 5 && comparison.uncertainCount > comparison.words.length * 0.3;
  const validPages = results.filter(result => result.status === "VALID" && result.signature_valid === true);
  const unscanned = collectionProgress?.pagesTotal
    ? collectionProgress.pagesCollected < collectionProgress.pagesTotal
    : validPages.reduce((max, result) => Math.max(max, result.page_count || 0), 0) > validPages.length;
  return <section className="photo-check" aria-label="Document check">
    <h2>Document check</h2>
    {collectionProgress?.documentWarning && !verifying && <p className="photo-summary" role="alert">{collectionProgress.documentWarning}</p>}
    {captureNotice && <p role="status">{captureNotice}</p>}
    {snapshot.preparing && <p role="status">Preparing text recognition on this device…</p>}
    {snapshot.error && <div role="alert"><p>{snapshot.error}</p><button onClick={() => checks.prepare().catch(() => {})}>Retry text recognition</button></div>}
    {!pages.length && !validPages.length && <p>Frame each whole page to begin. A seal alone does not check the surrounding printed text.</p>}
    {collectionProgress?.complete && !verifying && <p role="status">{collectionProgress.message}</p>}
    {scanning && !collectionProgress?.finished && pages.length > 0 &&
      <p role="status">Show the next page, or review the pages captured so far.</p>}
    {verifying ? <p role="status">Checking seals… Printed-text results are pending.</p> : <>
      {results.filter(result => result.status !== "VALID").map((result, index) => <p className="photo-summary" key={result.document_id || index}>
        {result.status === "INCOMPLETE" ? "This page needs more seal pieces. Keep scanning." : "This seal has not been authenticated. Printed text has not been checked."}
      </p>)}
      {unscanned && <p className="photo-summary">Other pages have not been checked. You can review the pages captured so far.</p>}
      {page && <section aria-label={`Review ${pageName(page.page)}`}>
        <h3 ref={heading} tabIndex={-1}>{pageName(page.page)} <span className="photo-note">· Seal authenticated</span></h3>
        <p className={`photo-summary ${page.state}`} role={page.state === "reading" ? "status" : undefined}>
          {page.state === "reading" ? photoProcessingMessage(page.progress) : labels[page.state]}</p>
        {page.state === "reading" && <progress max="1" value={page.progress ?? undefined} aria-label="Printed-text recognition" />}
        {page.error && <p role="alert">{page.error}</p>}
        {comparison && <>
          {difficultReading && <p className="photo-note reading-caution">Many characters could not be read reliably. Inspect the marked text on the paper; recognition errors can look like changes.</p>}
          <div className="photo-differences">
            {contentDifferences.length > 0 && <>
              <ol>{contentDifferences.map((difference, index) => <PhotoDifference key={index} page={page} difference={difference} />)}</ol>
              <p className="photo-note">Confirm the photo reading against the paper. A recognition error can also cause a difference.</p></>}
            {spacingDifferences.length > 0 && <details className="photo-typography photo-spacing">
              <summary>Word spacing to review ({spacingDifferences.length})</summary>
              <p className="photo-note">The characters agree, but words were split or joined. Check the spacing on the paper.</p>
              <ol>{spacingDifferences.map((difference, index) => <li key={index}>
                <div><strong>Signed text:</strong> {difference.expected}</div>
                <div><strong>Photo reading:</strong> {difference.observed}</div>
                <DifferenceCrop page={page} difference={difference} />
              </li>)}</ol>
            </details>}
            {typographyDifferences.length > 0 && <details className="photo-typography">
              <summary>Typography to review ({typographyDifferences.length})</summary>
              <p className="photo-note">Quotes, dashes, or joined letters were read differently. Check the highlighted photo to confirm the printed characters.</p>
              <ol>{typographyDifferences.map((difference, index) => <li key={index}>
                <div><strong>Signed text:</strong> {difference.expected}</div>
                <div><strong>Photo reading:</strong> {difference.observed}</div>
                <DifferenceCrop page={page} difference={difference} />
                {difference.context && <p className="photo-note">Signed wording nearby: {difference.context}</p>}
              </li>)}</ol>
            </details>}
          </div>
          {numbersToCheck.length > 0 && <details className="photo-reading-review photo-number-review" open>
            <summary>Numbers to check ({numbersToCheck.length})</summary>
            <ol>{numbersToCheck.map((difference, index) => <PhotoDifference key={index} page={page} difference={difference} />)}</ol>
          </details>}
          {readingsToCheck.length > 0 && <details className="photo-reading-review">
            <summary>Photo readings to check ({readingsToCheck.length})</summary>
            <ol>{readingsToCheck.map((difference, index) => <PhotoDifference key={index} page={page} difference={difference} />)}</ol>
          </details>}
          {comparison.retryReviews?.length > 0 && <details className="photo-typography photo-retries">
            <summary>Reread text to review ({comparison.retryReviews.length})</summary>
            <p className="photo-note">A closer reading disagreed with the first. Check these regions on the paper.</p>
            <ol>{comparison.retryReviews.map((reading, index) => <li key={index}>
              <div><strong>First reading:</strong> {reading.original}</div>
              <div><strong>Closer reading:</strong> {reading.observed}</div>
              <DifferenceCrop page={page} difference={{ ...reading, spacing: true }} />
            </li>)}</ol>
          </details>}
          {comparison.contrastAssisted && <p className="photo-note reading-caution">A contrast-assisted reading was needed. Inspect pale text and marks in the original photo; this reading can miss them.</p>}
          {comparison.originalComparison && <details className="photo-original-reading">
            <summary>First reading to review ({comparison.originalComparison.differences.length})</summary>
            <p className="photo-note">The first reading was less clear. Its differences are kept here so a faint addition cannot disappear from review.</p>
            <ol>{comparison.originalComparison.differences.map((difference, index) => <li key={index}>
              <div><strong>Signed text:</strong> {difference.expected || "(no text here)"}</div>
              <div><strong>First reading:</strong> {difference.observed || "(not read — inspect for missing text)"}</div>
              <DifferenceCrop page={{ ...page, comparison: comparison.originalComparison }} difference={difference} />
            </li>)}</ol>
          </details>}
          {comparison.markings?.length > 0 && <div className="photo-markings"><h3>QRed markings to inspect</h3>
            <p className="photo-note">These readings sit beside a QRed code. Check them on the paper; they are not authenticated document text.</p>
            {comparison.markings.map((marking, index) => <div key={index}><p>{marking.observed}</p>
              <DifferenceCrop page={page} difference={marking} /></div>)}
          </div>}
        </>}
        <div className="photo-actions">
          {onReplacePhoto && <button type="button" onClick={() => setRetake(page.page)}>{page.page.seal_sheet
            ? `Photograph original page ${page.page.page_number}` : "Retake this page"}</button>}
          {["error", "unreadable"].includes(page.state) && <button onClick={() => checks.retry(page.id)}>Read page again</button>}
        </div>
        {comparison && <>
          <div className="photo-actions">
            <label className="photo-inline"><input type="checkbox" checked={showMatches} onChange={event => setShowMatches(event.target.checked)} />Show matching words too</label>
            <label className="photo-inline">Zoom <select value={zoom} onChange={event => setZoom(Number(event.target.value))}>
              <option value="1">100%</option><option value="2">200%</option><option value="3">300%</option>
            </select></label>
          </div>
          <ul className="photo-legend"><li className="matched">Matching: {comparison.matchedCount}</li>
            <li className="different">Different or extra: {comparison.differentCount}</li><li className="uncertain">Uncertain: {comparison.uncertainCount}</li></ul>
        </>}
        {page.url && <div className="photo-scroll"><div className="photo-stage" style={{ width: `${zoom * 100}%` }}>
          <img src={page.url} alt="Page photo being compared with signed text" />
          {comparison && <svg viewBox={`0 0 ${page.width} ${page.height}`} aria-label="Text comparison highlights">
            {comparison.words.map((word, index) => word.bbox && (showMatches || word.status !== "matched") && <rect key={index}
              className={`photo-word ${word.status}`} x={word.bbox.x0} y={word.bbox.y0}
              width={word.bbox.x1 - word.bbox.x0} height={word.bbox.y1 - word.bbox.y0}
              role="button" tabIndex={0} aria-label={`${wordLabels[word.status]}: ${word.text}`}
              onClick={() => setSelectedWord(word)} onKeyDown={event => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedWord(word); }
              }}><title>{wordLabels[word.status]}: {word.text}</title></rect>)}
          </svg>}
        </div></div>}
        {selectedWord && <p className="photo-selected" role="status">{wordLabels[selectedWord.status]}: <strong>{selectedWord.text}</strong></p>}
        {comparison && <p className="photo-note">Text recognition can miss or misread marks. Check important numbers and unmarked areas. Photographs and handwriting need visual review.</p>}
      </section>}
      {pages.length > 0 && <nav aria-label="Page checks"><h3>Other page checks</h3><ul className="page-check-list">
        {pages.map(item => <li key={item.id}><button type="button" className={`page-check-status ${item.state}`}
          aria-pressed={page?.id === item.id} onClick={() => {
            selectedByUser.current = true; focusPage.current = item.id; setSelected(item.id);
          }}>
          <strong>{pageName(item.page)}</strong><span>Seal authenticated</span><span>{labels[item.state]}</span>
        </button></li>)}
      </ul></nav>}
    </>}
    {validPages.some(result => result.evidence) && <details open={!pages.length}>
      <summary>Compare the signed visual reference</summary>
      <PageEvidenceVerification results={results} scanPhotos={scanPhotos} session={session} onRetake={onReplacePhoto ? setRetake : undefined} />
    </details>}
    {retake && <PageCameraCapture pageLabel={pageName(retake)} separateOriginal={Boolean(retake.seal_sheet)} onClose={() => setRetake(null)}
      seals={seals.filter(seal => decodeSeal(seal)?.document_id === retake.document_id)}
      onCapture={file => { onReplacePhoto?.(retake.document_id, file); selectedByUser.current = true; setSelected(retake.document_id); }} />}
    <details><summary>Prepare for offline checking</summary>
      <p>Load the text reader while connected, then keep this tab open. Only QRed’s software and language data are cached.</p>
      <button type="button" disabled={snapshot.ready || snapshot.preparing} onClick={() => checks.prepare().catch(() => {})}>
        {snapshot.ready ? "Offline text checking ready" : "Prepare offline checking"}
      </button>
    </details>
    <p className="photo-note">QRed compares printed English text with the authenticated seal. Images and text stay in this session; QRed does not save them to your photo library or send them to a server.</p>
  </section>;
}

function PhotoDifference({ page, difference }) {
  return <li>
    {difference.review === "firstReading" && <p>The first reading found this wording in the same place. Check the photo to resolve the disagreement.</p>}
    {difference.review === "artwork" ? <p>The signed page image shows ink here. The seal has no wording for this area. Check the lettering on the page.</p>
      : <div><strong>Signed text:</strong> {difference.expected || "(no text here)"}</div>}
    <div><strong>Photo reading:</strong> {difference.observed || "(not read — inspect for missing text)"}</div>
    <DifferenceCrop page={page} difference={difference} />
    {difference.context && <p className="photo-note">Signed wording nearby: {difference.context}</p>}
  </li>;
}

function DifferenceCrop({ page, difference }) {
  const boxes = difference.boxes || difference.wordIndices.map(index => page.comparison.words.find(word => word.sourceIndex === index)?.bbox).filter(Boolean);
  if (!boxes.length) return <p className="photo-note">No reliable photo location. Inspect the signed wording and nearby text on the full page.</p>;
  const left = Math.max(0, Math.min(...boxes.map(box => box.x0)) - 70);
  const top = Math.max(0, Math.min(...boxes.map(box => box.y0)) - 24);
  const width = Math.min(page.width - left, Math.max(...boxes.map(box => box.x1)) - left + 70);
  const height = Math.min(page.height - top, Math.max(...boxes.map(box => box.y1)) - top + 24);
  return <svg className="difference-crop" viewBox={`${left} ${top} ${width} ${height}`} role="img" aria-label="Magnified photo difference">
    <image href={page.url} width={page.width} height={page.height} />
    {boxes.map((box, index) => <rect key={index} x={box.x0} y={box.y0} width={box.x1 - box.x0} height={box.y1 - box.y0} className={`photo-word ${difference.review || difference.typography || difference.spacing ? "uncertain" : "different"}`} />)}
  </svg>;
}
