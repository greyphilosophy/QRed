import { createRoot } from "react-dom/client";
import { QrScanner } from "./QrScanner.jsx";
import { verifyQRedSeals, qredTextFromScanResult, qredTextFromPhotoScanResult, qredDisplayTextFromScannedPayload } from "./qredVerifier.js";
import "./verifier.css";

function VerifierApp() {
  return (
    <div className="verifier-page">
      <header>
        <h1>QRed Verifier</h1>
        <p>Scan QR seals to verify a document — camera or manual entry</p>
      </header>
      <main>
        <QrScanner />

        <section className="result-card" style={{ marginTop: "1.25rem" }}>
          <label htmlFor="publicKeyInput" className="field-label">Issuer public key</label>
          <input
            id="publicKeyInput"
            type="text"
            placeholder="Paste issuer public key for signature verification"
            className="field-input"
          />
          <label htmlFor="manualSealInput" className="field-label">Manual seal entry or uploaded seal text</label>
          <textarea
            id="manualSealInput"
            rows={4}
            placeholder="Paste QRed seal strings here, one per line"
            className="field-input"
            style={{ resize: "vertical" }}
          />
          <input id="sealFileInput" type="file" accept=".txt,text/plain" className="field-input file-input" />
          <label htmlFor="pageTextInput" className="field-label">Page text read by scanner or pasted for comparison</label>
          <textarea
            id="pageTextInput"
            rows={4}
            placeholder="Scan QR Code to OCR the page, or paste document text here to compare"
            className="field-input"
            style={{ resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.75rem" }}>
            <button id="btnCompareText" className="btn btn-secondary" type="button">Compare page text</button>
            <button id="btnClear" className="btn btn-secondary" type="button">Clear</button>
          </div>
          <div id="ocrStatus" className="ocr-status" aria-live="polite" />
        </section>

        <section id="resultView" className="result-view">
          <div id="resultStatus" className="result-status" />
          <div id="resultMeta" className="result-meta" />
          <div id="resultContent" className="result-content" />
          <div id="textCompareView" className="text-compare-view" />
        </section>
      </main>

      <footer style={{ textAlign: "center", padding: "1rem", color: "#94a3b8", fontSize: "0.85rem" }}>
        QRed — Tamper-Evident Document Sealing <span className="app-version" id="appVersion">vrefactor</span>
      </footer>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<VerifierApp />);
}

// ── Legacy compat: expose hooks expected by offline HTML tests ──
// Python E2E and testHtml* guard tests used window.verifyQRedSeals / window.__qredStandaloneTestHooks
if (typeof window !== "undefined") {
  // Expose the real verifier directly — tests that call window.verifyQRedSeals(sealStrings, publicKey) continue to work
  window.verifyQRedSeals = async (sealStrings, publicKey) => {
    const rawSeals = (typeof sealStrings === "string" ? sealStrings : (sealStrings || []).join("\n"))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const result = await verifyQRedSeals(rawSeals, publicKey || "");

      // Best-effort DOM sync for tests that read #resultStatus
      const resultView = document.getElementById("resultView");
      const resultStatus = document.getElementById("resultStatus");
      const resultMeta = document.getElementById("resultMeta");
      const resultContent = document.getElementById("resultContent");
      if (resultView && resultStatus) {
        resultView.classList.add("visible");
        resultStatus.textContent = result.status;
        resultStatus.className = result.status === "VALID" ? "result-status valid" : "result-status";
      }
      if (resultMeta) {
        resultMeta.innerHTML = "";
        if (result.document_id) {
          const div = document.createElement("div");
          div.className = "meta-item";
          div.innerHTML = `<strong>Document:</strong> ${result.document_id}`;
          resultMeta.appendChild(div);
        }
        if (result.total_seals !== undefined) {
          const div2 = document.createElement("div");
          div2.className = "meta-item";
          div2.innerHTML = `<strong>Seals:</strong> ${result.total_seals} / ${result.total_required}`;
          resultMeta.appendChild(div2);
        }
      }
      if (resultContent && result.verified_content) {
        resultContent.textContent = result.verified_content;
      }
      return result;
    } catch (e) {
      return { status: "ERROR", error: e.message };
    }
  };

  window.__qredStandaloneTestHooks = {
    qredDisplayTextFromScannedPayload,
    qredTextFromPhotoScanResult,
    qredTextFromScanResult,
    verifyQRedSeals,
  };
}
