/* eslint-disable no-unused-vars */
import React, { useEffect, useRef, useState } from "react";
import { QrScanner } from "./QrScanner.jsx";
import { PdfSealForm } from "./PdfSealForm.jsx";
import { SealVerification, useSealVerification } from "./SealVerification.jsx";
import "./verification.css";
import { readPendingAuth } from "./sameTabAuth.js";

function App() {
  const [showPdfStampTool, setShowPdfStampTool] = useState(() =>
    Boolean(readPendingAuth()) || new URLSearchParams(window.location.search).has("qred_auth"));
  const stampSection = useRef(null);
  const stampHeading = useRef(null);
  const verification = useSealVerification();

  function scrollToStampTool() {
    const section = stampSection.current;
    if (!section) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    section.scrollIntoView?.({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    // Move keyboard/screen-reader focus with the newly opened section without
    // interrupting the browser's deliberate smooth scroll.
    stampHeading.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (showPdfStampTool) scrollToStampTool();
  }, [showPdfStampTool]);

  function openPdfStampTool() {
    if (showPdfStampTool) scrollToStampTool();
    else setShowPdfStampTool(true);
  }

  return (
    <main className="homepage">
      <QrScanner
        key={verification.session}
        returnPayload
        collectSeals
        collectionProgress={verification.progress}
        onSealDetected={verification.addSeal}
        onOpenPdfStampTool={openPdfStampTool}
        pdfStampToolOpen={showPdfStampTool}
        resultPanel={<div className="ar-result-panel"><h2>QR captured</h2><p>{verification.progress?.message || "See verification results below."}</p></div>}
      />
      <SealVerification verification={verification} />
      {showPdfStampTool && (
        <section className="pdf-stamp-tool" id="pdf-stamp-tool" ref={stampSection} aria-labelledby="pdf-stamp-heading">
          <div className="tool-header">
            <div>
              <p className="eyebrow">PDF stamping tool</p>
              <h2 id="pdf-stamp-heading" ref={stampHeading} tabIndex={-1}>Stamp a PDF with QRed seals</h2>
            </div>
            <button className="tool-close" onClick={() => setShowPdfStampTool(false)} type="button">
              Close
            </button>
          </div>
          <PdfSealForm onUsePublicKey={verification.setPublicKey} />
        </section>
      )}
      <footer className="policy-footer" aria-label="QRed policies and project documentation">
        <span>QRed · Tamper-evident document sealing</span>
        <nav aria-label="Policies and security information">
          <a href="/privacy.html">Privacy</a>
          <a href="/data-deletion.html">Data deletion</a>
          <a href="/terms.html">Terms</a>
          <a href="/security.html">Security &amp; architecture</a>
        </nav>
      </footer>
    </main>
  );
}

export default App;
