/* eslint-disable no-unused-vars */
import React, { useState } from "react";
import { QrScanner } from "./QrScanner.jsx";
import { PdfSealForm } from "./PdfSealForm.jsx";

function App() {
  const [showPdfStampTool, setShowPdfStampTool] = useState(false);

  return (
    <main className="homepage">
      <QrScanner onOpenPdfStampTool={() => setShowPdfStampTool(true)} />
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
