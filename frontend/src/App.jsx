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
        returnPayload
        onSealDetected={verification.addSeal}
        onOpenPdfStampTool={() => setShowPdfStampTool(true)}
        resultPanel={<div className="ar-result-panel"><h2>QR captured</h2><p>See verification results below. Scan again to collect the next seal.</p></div>}
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
          <PdfSealForm />
        </section>
      )}
    </main>
  );
}

export default App;
