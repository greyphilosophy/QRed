/* eslint-disable no-unused-vars */
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PageEvidenceVerification } from "./PageEvidenceVerification.jsx";
import { PageCameraCapture } from "./PageCameraCapture.jsx";
import { createPageTextChecks } from "./pageTextChecks.js";
import { decodeSeal } from "../qredVerifier.js";
import { photoProcessingMessage } from "./photoStatus.js";
import { OCR_REVIEW_THRESHOLD } from "./photoTextComparison.js";
import { createReviewItems, currentReview, reviewCounts } from "./reviewFindings.js";
import { ReadingViewer, ReviewReading } from "./ReviewReading.jsx";
import { ImageZoom } from "./ImageZoom.jsx";
import "./photoTextVerification.css";

const EMPTY = [];
const labels = {
  missing: "Printed text not checked — capture the whole page",
  queued: "Printed text waiting to be checked",
  reading: "Reading printed text…",
  matches: "Recognized text matches the signed text",
  differences: "Review needed — compare the marked text",
  uncertain: "Some readings need review",
  unreadable: "No text could be read — retake this page",
  error: "Text check could not finish — retry or retake",
};
const pageStateMark = { matches: "✓", differences: "!", uncertain: "?", unreadable: "!", error: "!" };
const wordLabels = { matched: "Matching text", different: "Different or extra text", uncertain: "Uncertain reading" };
const pageName = page => page.pdf ? `Page ${page.page_number} of ${page.page_count}` : "Signed text";

export function PhotoTextVerification({ session = 0, ...props }) {
  return <PageChecks key={session} {...props} session={session} />;
}

function PageChecks({ results = EMPTY, seals = EMPTY, scanPhotos = EMPTY, captureNotice = "", scanning = false, verifying = false, active = true,
  checks: providedChecks, onReplacePhoto, onFinish, onScanMore, onChooseMore, addingPage = false, collectionProgress, session }) {
  const [checks] = useState(() => providedChecks || createPageTextChecks());
  const snapshot = useSyncExternalStore(checks.subscribe, checks.getSnapshot);
  const [selected, setSelected] = useState(""), [retake, setRetake] = useState(null);
  const [reviews, setReviews] = useState({}), [showSummary, setShowSummary] = useState(false), [viewer, setViewer] = useState(null);
  const summaryHeading = useRef(null), focusFinding = useRef(false);
  const selectedByUser = useRef(false), openedPriority = useRef(0), heading = useRef(null), focusPage = useRef(null);
  const findingHeading = useRef(null), overviewHeading = useRef(null);
  useEffect(() => {
    if (active) return;
    // Keep the review and reading position, but release camera resources and
    // modal focus/scroll locks when another task view is shown. Returning to
    // this view must not reopen a camera without a fresh retake action.
    setRetake(null); setViewer(null);
    focusPage.current = null; focusFinding.current = false;
  }, [active]);
  useEffect(() => { checks.update(results, scanPhotos, { scanning, verifying }); }, [checks, results, scanPhotos, scanning, verifying]);
  useEffect(() => () => { if (!providedChecks) checks.dispose(); }, [checks, providedChecks]);
  const pages = useMemo(() => [...snapshot.pages].sort((a, b) => (a.page.page_number ?? 0) - (b.page.page_number ?? 0)), [snapshot.pages]);
  const page = pages.find(item => item.id === selected) || pages[0];
  const queues = useMemo(() => new Map(pages.map(item => [item.id, createReviewItems(item.comparison)])), [pages]);
  const items = queues.get(page?.id) || EMPTY;
  const review = page ? currentReview(reviews[page.id], page) : { index: 0, decisions: {} };
  const activeFinding = Math.min(review.index, Math.max(0, items.length - 1));
  const counts = reviewCounts(items, review.decisions);
  useEffect(() => {
    setReviews(previous => {
      const kept = Object.fromEntries(Object.entries(previous).filter(([id, saved]) => {
        const current = pages.find(item => item.id === id);
        return current && currentReview(saved, current) === saved;
      }));
      return Object.keys(kept).length === Object.keys(previous).length ? previous : kept;
    });
  }, [pages]);
  useEffect(() => {
    if (!active || selectedByUser.current || scanning || verifying) return;
    const priority = item => item.state === "differences" ? 4 : ["unreadable", "error"].includes(item.state) ? 3
      : item.state === "uncertain" ? (item.comparison?.markings?.length || item.comparison?.contrastAssisted ? 1 : 2) : 0;
    const issue = [...pages].sort((a, b) => priority(b) - priority(a))[0];
    if (issue && priority(issue) > openedPriority.current) {
      focusPage.current = issue.id;
      openedPriority.current = priority(issue); setSelected(issue.id);
    } else if (issue && !selected && pages.some(item => item.url && item.state === "matches")) {
      // A clean single-page scan also needs to bring the finished result into view.
      focusPage.current = issue.id; setSelected(issue.id);
    }
  }, [active, pages, scanning, verifying, selected]);
  useEffect(() => {
    if (!active || focusPage.current !== page?.id || !heading.current) return;
    focusPage.current = null;
    heading.current.focus({ preventScroll: true });
    heading.current.closest(".photo-result")?.scrollIntoView?.({ block: "start" });
  }, [active, page?.id, pages, showSummary]);
  useEffect(() => {
    if (!active || !focusFinding.current || !findingHeading.current || showSummary) return;
    focusFinding.current = false;
    findingHeading.current.focus({ preventScroll: true });
    findingHeading.current.scrollIntoView?.({ block: "start" });
  }, [active, activeFinding, page?.id, showSummary]);
  useEffect(() => {
    if (!active || !showSummary) return;
    summaryHeading.current?.focus({ preventScroll: true });
    summaryHeading.current?.scrollIntoView?.({ block: "start" });
  }, [active, showSummary]);
  function saveReview(target, changes) {
    setReviews(previous => ({ ...previous, [target.id]: { ...currentReview(previous[target.id], target),
      comparison: target.comparison, captureId: target.captureId, reference: target.reference, ...changes } }));
  }
  function selectPage(id) {
    const next = pages.find(item => item.id === id);
    if (!next) return;
    selectedByUser.current = true;
    focusPage.current = id; setSelected(id); setShowSummary(false); setViewer(null);
    if (id === page?.id && !showSummary) {
      heading.current?.focus({ preventScroll: true });
      heading.current?.closest(".photo-result")?.scrollIntoView?.({ block: "start" });
      focusPage.current = null;
    }
  }
  function selectFinding(index) {
    if (!page || !items[index]) return;
    saveReview(page, { index });
    focusFinding.current = true;
    if (index === activeFinding) {
      findingHeading.current?.focus({ preventScroll: true });
      findingHeading.current?.scrollIntoView?.({ block: "start" });
      focusFinding.current = false;
    }
  }
  function decide(value) {
    saveReview(page, { decisions: { ...review.decisions, [items[activeFinding].id]: value } });
  }
  function openSummary() { selectedByUser.current = true; setShowSummary(true); setViewer(null); }
  function openUnreviewed(target) {
    const nextItems = queues.get(target.id) || [], saved = currentReview(reviews[target.id], target);
    const pending = nextItems.findIndex(item => !saved.decisions[item.id]);
    const uncertain = nextItems.findIndex(item => saved.decisions[item.id] === "unsure");
    saveReview(target, { index: pending >= 0 ? pending : uncertain >= 0 ? uncertain : saved.index });
    selectPage(target.id);
  }
  const orderedOtherPages = page ? [...pages.slice(pages.indexOf(page) + 1), ...pages.slice(0, pages.indexOf(page))] : [];
  const nextPage = orderedOtherPages.find(item => reviewCounts(queues.get(item.id) || [], currentReview(reviews[item.id], item).decisions).pending);
  function nextReading() {
    if (activeFinding + 1 < items.length) selectFinding(activeFinding + 1);
    else if (nextPage) openUnreviewed(nextPage);
    else openSummary();
  }
  function viewFullPage() {
    overviewHeading.current?.scrollIntoView?.({ block: "start" });
    overviewHeading.current?.focus({ preventScroll: true });
  }
  function enlarge(mode, opener) { setViewer({ mode, opener, pageId: page.id, comparison: page.comparison }); }
  function pageProgress(item) {
    const queue = queues.get(item.id) || [];
    return queue.length ? `${reviewCounts(queue, currentReview(reviews[item.id], item).decisions).reviewed}/${queue.length} reviewed` : "";
  }
  const comparison = page?.comparison;
  const contentDifferences = comparison?.differences.filter(d => !d.typography && !d.spacing && !d.review) || [];
  const difficultReading = items.length > 0 && comparison?.words.length >= 5 &&
    comparison.words.filter(word => word.status === "uncertain" || word.confidence < OCR_REVIEW_THRESHOLD).length >
      comparison.words.length * 0.3;
  const validPages = results.filter(result => result.status === "VALID" && result.signature_valid === true);
  const unscanned = collectionProgress?.pagesTotal
    ? collectionProgress.pagesCollected < collectionProgress.pagesTotal
    : validPages.reduce((max, result) => Math.max(max, result.page_count || 0), 0) > validPages.length;
  const needsMorePages = unscanned || results.some(result => result.status === "INCOMPLETE");
  const addPageActions = needsMorePages && <AddPageActions onScan={onScanMore} onChoose={onChooseMore}
    disabled={addingPage} scanning={scanning} />;
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
      {showSummary && <ReviewSummary pages={pages} queues={queues} reviews={reviews} headingRef={summaryHeading}
        incomplete={unscanned || scanning || Boolean(collectionProgress?.documentWarning) || results.some(result => result.status !== "VALID" || result.signature_valid !== true)}
        validCount={validPages.length} onSelect={openUnreviewed} onFinish={onFinish} addPageActions={addPageActions} />}
      {!showSummary && !page && addPageActions}
      {page && !showSummary && <section className="photo-result" onPointerDown={() => { selectedByUser.current = true; }}
        onKeyDown={() => { selectedByUser.current = true; }} aria-label={`Review ${pageName(page.page)}`}>
        <div className="photo-review-header">
          <h3 ref={heading} tabIndex={-1}>{pageName(page.page)} <span className="photo-note">· Seal: authenticated</span></h3>
          <nav aria-label="Page checks" className="page-check-list">
            {pages.length <= 5 ? pages.map(item => <button type="button" key={item.id}
              className={`page-check-status ${item.state}`} title={labels[item.state]} aria-pressed={page.id === item.id}
              aria-label={`${pageName(item.page)} · Seal authenticated · ${labels[item.state]}${pageProgress(item) ? ` · ${pageProgress(item)}` : ""}`}
              onClick={() => selectPage(item.id)}>{item.page.page_number ? `Page ${item.page.page_number}` : "Signed text"}
              <span aria-hidden="true" className="page-state-mark">{queues.get(item.id)?.length
                ? pageProgress(item) : pageStateMark[item.state]}</span>
              <span className="sr-only"> · {labels[item.state]}</span></button>)
              : <select aria-label="Choose a page to review" value={page.id} onChange={event => selectPage(event.target.value)}>
                {pages.map(item => <option key={item.id} value={item.id} className={`page-check-status ${item.state}`}>{pageName(item.page)} · {pageProgress(item) || labels[item.state]}</option>)}
              </select>}
          </nav>
        </div>
        {(!items.length || !["matches", "differences", "uncertain"].includes(page.state)) && <p className={`photo-summary ${page.state}`} role={page.state === "reading" ? "status" : undefined}>
          {page.state === "reading" ? photoProcessingMessage(page.progress) : <>{!["missing", "queued"].includes(page.state) &&
            <span className="review-status-label">Printed text: </span>}{labels[page.state]}</>}</p>}
        {page.state === "reading" && <progress max="1" value={page.progress ?? undefined} aria-label="Printed-text recognition" />}
        {page.error && <p role="alert">{page.error}</p>}
        {comparison && <>
          <div className="photo-differences" data-count={items.length} data-content-count={contentDifferences.length}>
            {items.length > 0 && <>
              <div className="review-progress"><h4 className="photo-finding-heading" ref={findingHeading} tabIndex={-1} aria-live="polite">
                Reading {activeFinding + 1} of {items.length}</h4><span>{counts.reviewed}/{counts.total} reviewed</span></div>
              <ol start={activeFinding + 1}><ReviewReading page={page} item={items[activeFinding]}
                decision={review.decisions[items[activeFinding].id]} onDecision={decide} onEnlarge={enlarge} /></ol>
              <div className="photo-finding-controls" role="group" aria-label="Reading navigation">
                <div className="photo-finding-steps">
                  <button type="button" aria-label="Previous reading" disabled={activeFinding === 0} onClick={() => selectFinding(activeFinding - 1)}>Previous</button>
                  <button type="button" onClick={nextReading}>{activeFinding + 1 < items.length ? "Next reading" : nextPage ? "Next page to review" : "Review summary"}</button>
                </div>
                <div className="review-secondary-actions"><button type="button" className="photo-overview-link" onClick={viewFullPage}>All page highlights</button>
                  {activeFinding + 1 < items.length || nextPage ? <button type="button" className="photo-overview-link" onClick={openSummary}>Review summary</button> : null}</div>
              </div>
            </>}
          </div>
          {difficultReading && <p className="photo-note reading-caution">Many characters could not be read reliably. Inspect the marked text on the paper; recognition errors can look like changes.</p>}
        </>}
        {addPageActions}
        {page.url && <section className="photo-full-page" aria-label="Full page photo">
          <div className="photo-overview-header">
            <h4 ref={overviewHeading} tabIndex={-1}>Full page</h4>
            {items.length > 0 && <button type="button" onClick={() => selectFinding(activeFinding)}>Back to reading</button>}
          </div>
          <PagePhoto key={`${page.id}:${page.captureId}`} page={page} contentDifferences={items.map(item => ({ ...item.difference,
            wordIndices: item.source === "current" ? item.difference.wordIndices : [] }))} decisions={items.map(item => review.decisions[item.id])}
            finding={activeFinding} onFinding={selectFinding} />
        </section>}
        <div className="photo-actions">
          {onReplacePhoto && <button type="button" onClick={() => setRetake(page.page)}>{page.page.seal_sheet
            ? `Photograph original page ${page.page.page_number}` : "Retake this page"}</button>}
          {["error", "unreadable"].includes(page.state) && <button onClick={() => checks.retry(page.id)}>Read page again</button>}
          {!comparison && <button type="button" onClick={openSummary}>Review summary</button>}
        </div>
        {comparison && !items.length && <button type="button" onClick={nextPage ? () => openUnreviewed(nextPage) : openSummary}>
          {nextPage ? "Next page to review" : "Review summary"}</button>}
        {comparison && <p className="photo-note">Text recognition can miss or misread marks. Check important numbers and unmarked areas. Photographs and handwriting need visual review.</p>}
      </section>}
    </>}
    {active && viewer && page?.url && viewer.pageId === page.id && viewer.comparison === page.comparison && <ReadingViewer
      page={page} item={items[activeFinding]} decision={review.decisions[items[activeFinding]?.id]}
      initialMode={viewer.mode} opener={viewer.opener} onClose={() => setViewer(null)} />}
    {validPages.some(result => result.evidence) && <details open={!pages.length}>
      <summary>Compare the signed visual reference</summary>
      <PageEvidenceVerification results={results} scanPhotos={scanPhotos} session={session} onRetake={onReplacePhoto ? setRetake : undefined} />
    </details>}
    {active && retake && <PageCameraCapture pageLabel={pageName(retake)} separateOriginal={Boolean(retake.seal_sheet)} onClose={() => setRetake(null)}
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

function AddPageActions({ onScan, onChoose, disabled, scanning }) {
  if (!onScan && !onChoose) return null;
  return <div className="review-add-page" role="group" aria-label="Add missing pages">
    {onScan && <button type="button" disabled={disabled} onClick={onScan}>{scanning ? "Return to camera" : "Scan next page"}</button>}
    {onChoose && <button type="button" disabled={disabled} onClick={onChoose}>Choose next page</button>}
  </div>;
}

function ReviewSummary({ pages, queues, reviews, headingRef, incomplete, validCount, onSelect, onFinish, addPageActions }) {
  const rows = pages.map(page => ({ page, counts: reviewCounts(queues.get(page.id) || [], currentReview(reviews[page.id], page).decisions) }));
  const total = rows.reduce((all, row) => {
    for (const key of Object.keys(all)) all[key] += row.counts[key];
    return all;
  }, { total: 0, reviewed: 0, matches: 0, differs: 0, unsure: 0, pending: 0 });
  const unfinished = rows.filter(({ page }) => !page.comparison || ["error", "unreadable"].includes(page.state));
  const title = incomplete || unfinished.length ? "Document check incomplete" : total.pending ? "Review in progress"
    : !total.total ? "No flagged readings to review" : total.unsure ? "Review finished with unclear readings"
      : total.differs ? "Review finished — discrepancies recorded" : "All flagged readings reviewed";
  const next = rows.find(row => row.counts.pending) || rows.find(row => row.counts.unsure) || unfinished[0] || rows.find(row => row.counts.total);
  return <section className="review-summary" aria-label="Review summary">
    <h3 ref={headingRef} tabIndex={-1}>Review summary</h3>
    <p className="review-summary-status" role="status">{title}</p>
    <p><strong>Seal checks:</strong> {validCount} authenticated page{validCount === 1 ? "" : "s"}.</p>
    {incomplete && <p className="photo-note">Some pages or seals still need checking. This summary covers the available readings.</p>}
    {addPageActions}
    {unfinished.length > 0 && <p className="photo-note">Text checking is unfinished on {unfinished.length} page{unfinished.length === 1 ? "" : "s"}.</p>}
    {total.total > 0 && <>
      <h4>Your observations</h4>
      <p>{total.reviewed} of {total.total} review decisions recorded.</p>
      <dl className="review-totals">
        <div><dt>No discrepancy seen</dt><dd>{total.matches}</dd></div>
        <div><dt>Discrepancy or concern</dt><dd>{total.differs}</dd></div>
        <div><dt>Can't tell</dt><dd>{total.unsure}</dd></div>
        <div><dt>No decision yet</dt><dd>{total.pending}</dd></div>
      </dl>
    </>}
    <div className="photo-actions">{next && <button type="button" onClick={() => onSelect(next.page)}>{total.pending || total.unsure || unfinished.length ? "Continue review" : "Revisit readings"}</button>}
      {onFinish && <button type="button" className="photo-overview-link" onClick={onFinish}>Finish &amp; clear</button>}</div>
    <ul className="review-page-results">{rows.map(({ page, counts }) => <li key={page.id}>
      <button type="button" onClick={() => onSelect(page)}><strong>{pageName(page.page)}</strong><span>{counts.total
        ? `${counts.reviewed}/${counts.total} reviewed · ${counts.pending} undecided · ${counts.unsure} unclear`
        : labels[page.state]}</span></button>
    </li>)}</ul>
    <p className="photo-note">These decisions are your observations, separate from seal authentication. Text recognition does not check every mark, image, or handwritten addition; inspect the whole page too.</p>
    {total.total > 0 && <p className="photo-note">Review decisions stay in this session. You can revisit and change them; a new photo needs a new review.</p>}
  </section>;
}

function PagePhoto({ page, contentDifferences, decisions = [], finding, onFinding }) {
  const { comparison } = page;
  const [showMatches, setShowMatches] = useState(false), [selectedWord, setSelectedWord] = useState(null);
  const [zoom, setZoom] = useState(1);
  const wordToFinding = new Map();
  contentDifferences.forEach((item, i) => (item.wordIndices || []).forEach(index => wordToFinding.set(index, i)));
  const visibleWords = comparison?.words.filter(word => word.bbox && (showMatches || word.status !== "matched")) || EMPTY;
  const regionKey = (box, index) => `${index}:${box.x0}:${box.y0}:${box.x1}:${box.y1}`;
  const wordRegions = new Set(visibleWords.filter(word => wordToFinding.has(word.sourceIndex))
    .map(word => regionKey(word.bbox, wordToFinding.get(word.sourceIndex))));
  const extraRegions = contentDifferences.flatMap((d, index) => (d.boxes || [])
    .filter(box => !wordRegions.has(regionKey(box, index))).map(box => ({ box, index })));
  const tone = index => decisions[index] === "differs" ? "different" : decisions[index] === "matches" ? "matched" : "uncertain";
  function selectWord(word) {
    if (wordToFinding.has(word.sourceIndex)) selectRegion(wordToFinding.get(word.sourceIndex));
    else setSelectedWord(word);
  }
  function selectRegion(index) { setSelectedWord(null); onFinding(index); }
  useEffect(() => { setSelectedWord(null); }, [finding]);
  const activate = callback => event => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); callback(); }
  };
  function selectNearby(event) {
    // Keep the drawn boxes exact. Resolve taps in the surrounding 22 CSS pixels
    // by distance to the ink, so overlapping touch areas do not steal a reading.
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const sx = bounds.width / page.width, sy = bounds.height / page.height;
    const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    const targets = [
      ...visibleWords.map(word => ({ box: word.bbox, select: () => selectWord(word) })),
      ...extraRegions.map(({ box, index }) => ({ box, select: () => selectRegion(index) })),
    ].map(target => {
      const { box } = target;
      const dx = Math.max(box.x0 * sx - x, 0, x - box.x1 * sx);
      const dy = Math.max(box.y0 * sy - y, 0, y - box.y1 * sy);
      return { ...target, dx, dy, distance: dx * dx + dy * dy,
        center: (x - (box.x0 + box.x1) * sx / 2) ** 2 + (y - (box.y0 + box.y1) * sy / 2) ** 2 };
    }).filter(target => target.dx <= 22 && target.dy <= 22)
      .sort((a, b) => a.distance - b.distance || a.center - b.center);
    targets[0]?.select();
  }
  const clickTarget = callback => event => { event.stopPropagation(); callback(); };
  return <>
    <div className={`photo-scroll${zoom > 1 ? " zoomed" : ""}`}><div className="photo-stage" onClick={selectNearby}
      style={{ "--photo-ratio": page.width && page.height ? page.width / page.height : undefined, "--photo-zoom": zoom }}>
      <img src={page.url} alt="Page photo being compared with signed text" />
      {comparison && <svg viewBox={`0 0 ${page.width} ${page.height}`} aria-label="Text comparison highlights">
        {visibleWords.map((word, index) => <rect key={index}
          className={`photo-word ${word.status === "matched" ? "matched" : tone(wordToFinding.get(word.sourceIndex))}${wordToFinding.get(word.sourceIndex) === finding ? " current-finding" : ""}`}
          x={word.bbox.x0} y={word.bbox.y0} width={word.bbox.x1 - word.bbox.x0} height={word.bbox.y1 - word.bbox.y0}
          role="button" tabIndex={0} aria-label={`${wordLabels[word.status]}: ${word.text}`}
          onClick={clickTarget(() => selectWord(word))} onKeyDown={activate(() => selectWord(word))} />)}
        {/* A word and its review item share one hit target. Extra region
            targets are for locations without that clickable OCR word. */}
        {extraRegions.map(({ box, index: i }, j) => <rect key={`missing-${i}-${j}`}
          className={`photo-word ${tone(i)} missing-region${i === finding ? " current-finding" : ""}`}
          x={box.x0} y={box.y0} width={box.x1 - box.x0} height={box.y1 - box.y0}
          role="button" tabIndex={0} aria-label={`Reading ${i + 1}: ${contentDifferences[i].expected || contentDifferences[i].observed || "Inspect page"}`}
          onClick={clickTarget(() => selectRegion(i))} onKeyDown={activate(() => selectRegion(i))} />)}
      </svg>}
    </div></div>
    {comparison && <div className="photo-view-tools">
      <label className="photo-inline"><input type="checkbox" checked={showMatches} onChange={e => setShowMatches(e.target.checked)} />Show matching words too</label>
      <ImageZoom value={zoom} onChange={setZoom} label="Page zoom" />
    </div>}
    {contentDifferences.length > 0 && <p className="photo-note">Tap a marked area to review it. Zoom in for nearby readings.</p>}
    {selectedWord && <p className="photo-selected" role="status">{wordLabels[selectedWord.status]}: <strong>{selectedWord.text}</strong></p>}
    {comparison && <ul className="photo-legend" aria-label="Word counts">
      <li className="matched">OCR matches: {comparison.matchedCount}</li>
      <li className="different">OCR differences: {comparison.differentCount}</li>
      <li className="uncertain">OCR uncertain: {comparison.uncertainCount}</li>
    </ul>}
  </>;
}
