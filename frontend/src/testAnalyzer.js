/* eslint-disable no-unused-vars */
// QRed — QR Photo Analyzer core (ES module, Vite entry)
// Decoupled from inline HTML script so it's importable by both built HTML and tests.
// Originally lived inside frontend/test.html as a 900-line <script type=module>.

import jsQR from "jsqr";
import { scanQrImage } from "./qr/scanQrImage.js";
import { decodeSeal, verifyQRedSeals, qredDisplayTextFromScannedPayload,
  qredTextFromScanResult as scannedPayload } from "./qredVerifier.js";
import { isQRedEntryLink, qredPayloadFromScanResult } from "./qr/qrPayload.js";
import { QR_MODULE_COUNT_BY_VERSION } from "./qr/qrLowLevel.js";

export { jsQR, qredDisplayTextFromScannedPayload };

export function qredTextFromScanResult(scanResult) {
  return qredDisplayTextFromScannedPayload(scannedPayload(scanResult));
}

export function qredTextFromPhotoScanResult(_imageData, _width, _height, scanResult) {
  return qredTextFromScanResult(scanResult);
}

// — QR detection (jsQR only — BarcodeDetector path removed for simplicity; jsQR is already bundled)
export async function detectQRCodeFromImage(imgElement) {
  const canvas = document.createElement("canvas");
  canvas.width = imgElement.naturalWidth || imgElement.width;
  canvas.height = imgElement.naturalHeight || imgElement.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(imgElement, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return scanQrImage(imageData.data, imageData.width, imageData.height);
}

// — formatting
export function formatHexDump(bytes, start = 0, length = bytes?.length ?? 0) {
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const end = Math.min(source.length, start + length);
  const lines = [];
  for (let offset = start; offset < end; offset += 16) {
    const chunk = Array.from(source.slice(offset, Math.min(end, offset + 16)));
    const hex = chunk.map((value) => value.toString(16).padStart(2, "0")).join(" ");
    const ascii = chunk.map((value) => (value >= 32 && value <= 126 ? String.fromCharCode(value) : ".")).join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(47, " ")}  ${ascii}`);
  }
  return lines.join("\n");
}

export function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fileSelectionKey(files) {
  return Array.from(files || [])
    .map((file) => `${file.name}:${file.size}:${file.lastModified}`)
    .join("|");
}

// — UI controller (upload + results rendering)
export function createTestAnalyzerController({ uploadZone, fileInput: _fileInput, uploadStatus, resultsDiv } = {}) {
  let awaitingFileSelection = false;
  let activeSelectionKey = null;
  let activeSelectionAt = 0;

  function setUploadStatus(message, tone = "ready") {
    if (!uploadStatus || !uploadZone) return;
    uploadStatus.textContent = message;
    uploadStatus.classList.remove("loading", "ready", "done");
    uploadStatus.classList.add(tone);
    uploadZone.classList.toggle("scanning", tone === "loading");
  }

  async function updateSealPayloadSection(card, code) {
    const section = card.querySelector("[data-seal-payload-state]");
    if (!section) return;
    const payload = qredPayloadFromScanResult(code);
    if (!payload) {
      section.dataset.sealPayloadState = "navigation";
      section.innerHTML = `<h4>QRed navigation code</h4><p>This code opens qred.org. Scan the page watermark to recover its document seal.</p>`;
      return;
    }
    const decoded = decodeSeal(payload);
    const result = await verifyQRedSeals([payload], "");
    const recoveredText = result.content
      ? `Recovered text (signature not verified):\n${result.content}`
      : result.evidence
        ? `Recovered ${result.evidence.blank ? "blank-page marker" : "visual page reference"} (signature not verified). Open the verifier to authenticate and compare this page.`
        : result.status === "INCOMPLETE"
          ? `Seal ${decoded.chunk_number + 1} of ${decoded.total_chunks}. Collect all seals in the verifier to restore the text.`
          : `Cannot restore seal text: ${result.error_message}`;
    section.dataset.sealPayloadState = "found";
    section.innerHTML = `<h4>QRed seal found</h4>
      <p style="margin-bottom: 0.5rem;"><span class="badge badge-success">Seal decoded</span></p>
      <div class="payload-text">${escapeHtml(recoveredText)}</div>`;
  }

  function renderResultCard(file, code, imgElement) {
    const card = document.createElement("div");
    card.className = "result-card";
    const imgWidth = imgElement?.naturalWidth || imgElement?.width || "—";
    const imgHeight = imgElement?.naturalHeight || imgElement?.height || "—";

    if (!code) {
      card.classList.add("error");
      card.innerHTML = `\n      <h3>⚠️ No QR code detected</h3>\n      <img class="preview-img" src="${URL.createObjectURL(file)}" alt="Photo preview">\n      <div class="detail-grid">\n        <span class="label">File</span><span class="value">${escapeHtml(file.name)}</span>\n        <span class="label">Size</span><span class="value">${(file.size / 1024).toFixed(1)} KB</span>\n        <span class="label">Dimensions</span><span class="value">${imgWidth} × ${imgHeight}</span>\n      </div>\n    `;
      return card;
    }

    card.classList.add("success");
    const version = code.version || "—";
    const moduleCount = version !== "—" ? QR_MODULE_COUNT_BY_VERSION[version] : "—";
    const looksLikeQRed = Boolean(qredPayloadFromScanResult(code)) || isQRedEntryLink(code.data);
    const sealSection = looksLikeQRed
      ? `<div class="seal-payload-section" data-seal-payload-state="pending"><h4>Reading QRed seal…</h4></div>`
      : "";

    let hexDumpSection = "";
    if (code.binaryData && code.binaryData.length > 0) {
      const hexDump = formatHexDump(code.binaryData, 0, Math.min(code.binaryData.length, 512));
      hexDumpSection = `\n      <h4 style="margin-top: 1rem;">Raw Binary Data (first ${Math.min(code.binaryData.length, 512)} bytes)</h4>\n      <div class="hex-dump">${escapeHtml(hexDump)}</div>\n    `;
    }

    let locationSection = "";
    if (code.location) {
      const tl = code.location.topLeftCorner;
      const br = code.location.bottomRightCorner;
      locationSection = `\n      <span class="label">Detected in</span><span class="value">(${Math.round(tl.x)}, ${Math.round(tl.y)}) → (${Math.round(br.x)}, ${Math.round(br.y)})</span>\n    `;
    }

    const previewUrl = URL.createObjectURL(file);
    card.innerHTML = `\n    <h3>✅ QR Code Decoded</h3>\n    <img class="preview-img" src="${previewUrl}" alt="Photo preview">\n    <div class="detail-grid">\n      <span class="label">File</span><span class="value">${escapeHtml(file.name)}</span>\n      <span class="label">Decoded text</span><span class="value" style="color: var(--primary);">${escapeHtml(code.data || "Binary QR message")}</span>\n      <span class="label">QR Version</span><span class="value">${version}</span>\n      <span class="label">Module count</span><span class="value">${moduleCount} × ${moduleCount}</span>\n      <span class="label">Raw binary bytes</span><span class="value">${code.binaryData ? code.binaryData.length : 0}</span>\n      ${locationSection}\n      <span class="label">QRed indicator</span><span class="value">${looksLikeQRed ? '<span class="badge badge-success">Yes</span>' : '<span class="badge badge-info">No</span>'}</span>\n    </div>\n    ${sealSection}\n    ${hexDumpSection}\n  `;

    if (looksLikeQRed) {
      setTimeout(() => updateSealPayloadSection(card, code), 0);
    }

    return card;
  }

  async function handleSelectedFiles(files, source = "change") {
    const fileArray = Array.from(files || []);
    if (fileArray.length === 0) return;

    const selectionKey = fileSelectionKey(fileArray);
    if (selectionKey === activeSelectionKey && Date.now() - activeSelectionAt < 1500) return;
    activeSelectionKey = selectionKey;
    activeSelectionAt = Date.now();

    awaitingFileSelection = false;
    const firstFileName = fileArray[0]?.name || "photo";
    setUploadStatus(
      source === "click" ? `Opening picker for ${firstFileName}…` : `Selected ${fileArray.length} photo${fileArray.length === 1 ? "" : "s"}…`,
      "loading"
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await processFiles(fileArray);
  }

  async function processFiles(files) {
    if (!resultsDiv) return;
    resultsDiv.innerHTML = "";
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    setUploadStatus(`Scanning ${fileArray.length} photo${fileArray.length === 1 ? "" : "s"}…`, "loading");

    for (let index = 0; index < fileArray.length; index += 1) {
      const file = fileArray[index];
      setUploadStatus(`Scanning photo ${index + 1} of ${fileArray.length}…`, "loading");
      const placeholder = document.createElement("div");
      placeholder.className = "result-card loading";
      placeholder.innerHTML = `\n      <h3>⏳ Processing photo…</h3>\n      <div class="detail-grid">\n        <span class="label">File</span><span class="value">${escapeHtml(file.name)}</span>\n        <span class="label">Status</span><span class="value">Loading image and decoding QR…</span>\n      </div>\n    `;
      resultsDiv.appendChild(placeholder);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const card = await processOneFile(file);
      placeholder.replaceWith(card);
    }

    setUploadStatus(`Done scanning ${fileArray.length} photo${fileArray.length === 1 ? "" : "s"}.`, "done");
  }

  function processOneFile(file) {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);

      const finish = (card) => {
        URL.revokeObjectURL(url);
        resolve(card);
      };

      img.onload = async () => {
        try {
          const code = await detectQRCodeFromImage(img);
          finish(code ? renderResultCard(file, code, img) : renderResultCard(file, null, img));
        } catch {
          finish(renderResultCard(file, null, img));
        }
      };

      img.onerror = () => finish(renderResultCard(file, null, null));
      img.src = url;
    });
  }

  // Exposed for tests — stable names matching guard tests
  return {
    fileSelectionKey,
    renderResultCard,
    processOneFile,
    detectQRCodeFromImage,
    qredDisplayTextFromScannedPayload,
    qredTextFromPhotoScanResult,
    qredTextFromScanResult,
    handleSelectedFiles,
    processFiles,
    // internals exposed so legacy guard tests can still assert presence
    get awaitingFileSelection() {
      return awaitingFileSelection;
    },
    set awaitingFileSelection(v) {
      awaitingFileSelection = v;
    },
    get activeSelectionKey() {
      return activeSelectionKey;
    },
    set activeSelectionKey(v) {
      activeSelectionKey = v;
    },
    get activeSelectionAt() {
      return activeSelectionAt;
    },
    set activeSelectionAt(v) {
      activeSelectionAt = v;
    },
  };
}

export default createTestAnalyzerController;
