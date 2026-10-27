/* eslint-disable no-unused-vars */
import React, { useState } from "react";
import { QrScanner } from "./QrScanner.jsx";
import { PdfSealForm } from "./PdfSealForm.jsx";
import { SealVerification, useSealVerification } from "./SealVerification.jsx";
import "./verification.css";

function App() {
  const [showPdfStampTool, setShowPdfStampTool] = useState(false);
  const verification = useSealVerification();

  return (
    <main className="homepage">
      <QrScanner
        key={verification.session}
        returnPayload
        collectSeals
        collectionProgress={verification.progress}
        onSealDetected={verification.addSeal}
        onOpenPdfStampTool={() => setShowPdfStampTool(true)}
        resultPanel={<div className="ar-result-panel"><h2>QR captured</h2><p>{verification.progress?.message || "See verification results below."}</p></div>}
      />
      <SealVerification verification={verification} />
      {showPdfStampTool && (
        <section className="pdf-stamp-tool" id="pdf-stamp-tool">
          <div className="tool-header">
            <div>
              <p className="eyebrow">PDF stamping tool</p>
              <h2>Stamp a PDF with QRed seals</h2>
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
