/* eslint-disable no-unused-vars */
// QRed — QR Photo Analyzer core (ES module, Vite entry)
// Decoupled from inline HTML script so it's importable by both built HTML and tests.
// Originally lived inside frontend/test.html as a 900-line <script type=module>.

import jsQR from "jsqr";
import { VISIBLE_QR_TEXT, extractHiddenQRedPayload, hiddenPayloadByteOffset } from "./qr/hiddenPayload.js";
import { codewordsFromMatrix, deinterleaveDataCodewordsWithTables, QR_MODULE_COUNT_BY_VERSION } from "./qr/qrLowLevel.js";
import { sampleQrMatrix } from "./qr/qrImageRecovery.js";

export { VISIBLE_QR_TEXT, extractHiddenQRedPayload, hiddenPayloadByteOffset, jsQR };

// — seal fragment display helpers
function sealFragment(sealString) {
  const hashIndex = String(sealString || "").indexOf("#");
  return hashIndex >= 0 ? sealString.slice(hashIndex + 1) : String(sealString || "");
}

function decodePlaintextFragment(fragment) {
  if (!fragment.startsWith("QRED1?")) return null;
  const params = new URLSearchParams(fragment.slice("QRED1?".length));
  const chunkNumber = Number.parseInt(params.get("i") || "", 10);
  const totalChunks = Number.parseInt(params.get("n") || "", 10);
  const documentId = params.get("doc") || "";
  if (!documentId || !Number.isInteger(chunkNumber) || !Number.isInteger(totalChunks)) return null;
  return params.get("txt") || "";
}

export function qredDisplayTextFromScannedPayload(payload) {
  const fragment = sealFragment(payload);
  const plaintext = decodePlaintextFragment(fragment);
  return plaintext || (payload || "");
}

export function qredTextFromScanResult(scanResult) {
  if (!scanResult || typeof scanResult === "string") return scanResult || "";
  const visibleText = scanResult.data || "";
  const hiddenPayload = extractHiddenQRedPayload(scanResult.binaryData, scanResult.version);
  if (visibleText === VISIBLE_QR_TEXT || visibleText.includes("QRED1") || visibleText.includes("qred.org")) {
    return hiddenPayload ? qredDisplayTextFromScannedPayload(hiddenPayload) : qredDisplayTextFromScannedPayload(visibleText);
  }
  return visibleText;
}


export function extractHiddenQRedPayloadFromImage(imageData, width, height, scanResult) {
  if (!scanResult?.location || !scanResult.version) return null;

  // Fast path — centered adaptive sample first (>90% clean photos)
  {
    const matrix = sampleQrMatrix(imageData, width, height, scanResult.location, scanResult.version, { rowOffset: 0.5, colOffset: 0.5 });
    const { codewords, ecLevelBits } = codewordsFromMatrix(matrix, scanResult.version);
    const payload = extractHiddenQRedPayload(deinterleaveDataCodewordsWithTables(codewords, scanResult.version, ecLevelBits), scanResult.version);
    if (payload) return payload;
  }

  const thresholds = [undefined, 128, 96, 112, 144, 160];
  const offsets = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65];
  const counts = new Map();
  for (const threshold of thresholds) {
    for (const rowOffset of offsets) {
      for (const colOffset of offsets) {
        if (threshold === undefined && rowOffset === 0.5 && colOffset === 0.5) continue;
        const matrix = sampleQrMatrix(imageData, width, height, scanResult.location, scanResult.version, { rowOffset, colOffset, threshold });
        const { codewords, ecLevelBits } = codewordsFromMatrix(matrix, scanResult.version);
        const payload = extractHiddenQRedPayload(deinterleaveDataCodewordsWithTables(codewords, scanResult.version, ecLevelBits), scanResult.version);
        if (!payload) continue;
        const nextCount = (counts.get(payload) || 0) + 1;
        counts.set(payload, nextCount);
        if (nextCount >= 2) return payload;
      }
    }
  }
  let bestPayload = null;
  let bestCount = 0;
  for (const [payload, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestPayload = payload;
    }
  }
  return bestPayload;
}

export function qredTextFromPhotoScanResult(imageData, width, height, scanResult) {
  const visibleText = qredTextFromScanResult(scanResult);
  if (!imageData || !width || !height) return qredDisplayTextFromScannedPayload(visibleText);
  const recoveredPayload = extractHiddenQRedPayloadFromImage(imageData, width, height, scanResult) || visibleText;
  return qredDisplayTextFromScannedPayload(recoveredPayload);
}

// — QR detection (jsQR only — BarcodeDetector path removed for simplicity; jsQR is already bundled)
export async function detectQRCodeFromImage(imgElement) {
  const canvas = document.createElement("canvas");
  canvas.width = imgElement.naturalWidth || imgElement.width;
  canvas.height = imgElement.naturalHeight || imgElement.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(imgElement, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "attemptBoth" });
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

  function updateHiddenPayloadSection(card, code, imgElement, version, payloadOffset) {
    const section = card.querySelector("[data-hidden-payload-state]");
    if (!section) return;

    const qrCanvas = document.createElement("canvas");
    qrCanvas.width = imgElement?.naturalWidth || imgElement?.width || 0;
    qrCanvas.height = imgElement?.naturalHeight || imgElement?.height || 0;
    const qrCtx = qrCanvas.getContext("2d");
    if (!imgElement || !qrCtx || qrCanvas.width === 0 || qrCanvas.height === 0) {
      section.innerHTML = `\n      <h4>🔍 QRed QR detected — checking for hidden payload...</h4>\n      <p style="margin-bottom: 0.5rem;"><span class="badge badge-warning">Hidden payload: NOT FOUND</span></p>\n      <p style="font-size: 0.85rem; color: var(--text-dim);">This QR code has the QRed visible text but no hidden payload was detected in the expected offset.</p>\n    `;
      return;
    }

    qrCtx.drawImage(imgElement, 0, 0);
    const qrImageData = qrCtx.getImageData(0, 0, qrCanvas.width, qrCanvas.height);
    const recoveredText = qredTextFromPhotoScanResult(qrImageData.data, qrImageData.width, qrImageData.height, code);
    if (recoveredText !== code.data) {
      section.innerHTML = `\n      <h4>🔍 Hidden QRed Payload Found</h4>\n      <p style="margin-bottom: 0.5rem;"><span class="badge badge-success">Hidden payload: YES</span></p>\n      <p style="font-size: 0.85rem; color: var(--text-dim); margin-bottom: 0.5rem;">Payload byte offset: ${payloadOffset} | Payload length: ${recoveredText.length} bytes</p>\n      <div class="payload-text">${escapeHtml(recoveredText)}</div>\n    `;
      return;
    }

    section.innerHTML = `\n    <h4>🔍 QRed QR detected — checking for hidden payload...</h4>\n    <p style="margin-bottom: 0.5rem;"><span class="badge badge-warning">Hidden payload: NOT FOUND</span></p>\n    <p style="font-size: 0.85rem; color: var(--text-dim);">This QR code has the QRed visible text but no hidden payload was detected in the expected offset.</p>\n  `;
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
    const looksLikeQRed = code.data === VISIBLE_QR_TEXT || code.data.includes("QRED1") || code.data.includes("qred.org");
    const payloadOffset = looksLikeQRed ? hiddenPayloadByteOffset(version) : "—";

    let hiddenSection = "";
    if (looksLikeQRed) {
      hiddenSection = `\n      <div class="hidden-payload-section" data-hidden-payload-state="pending">\n        <h4>🔍 QRed QR detected — checking for hidden payload...</h4>\n        <p style="margin-bottom: 0.5rem;"><span class="badge badge-info">Hidden payload: LOADING</span></p>\n        <p style="font-size: 0.85rem; color: var(--text-dim);">Recovering the hidden photo payload…</p>\n      </div>\n    `;
    }

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
    card.innerHTML = `\n    <h3>✅ QR Code Decoded</h3>\n    <img class="preview-img" src="${previewUrl}" alt="Photo preview">\n    <div class="detail-grid">\n      <span class="label">File</span><span class="value">${escapeHtml(file.name)}</span>\n      <span class="label">Visible text</span><span class="value" style="color: var(--primary);">${escapeHtml(code.data)}</span>\n      <span class="label">QR Version</span><span class="value">${version}</span>\n      <span class="label">Module count</span><span class="value">${moduleCount} × ${moduleCount}</span>\n      <span class="label">Raw binary bytes</span><span class="value">${code.binaryData ? code.binaryData.length : 0}</span>\n      ${locationSection}\n      <span class="label">QRed indicator</span><span class="value">${looksLikeQRed ? '<span class="badge badge-success">Yes</span>' : '<span class="badge badge-info">No</span>'}</span>\n    </div>\n    ${hiddenSection}\n    ${hexDumpSection}\n  `;

    if (looksLikeQRed) {
      setTimeout(() => updateHiddenPayloadSection(card, code, imgElement, version, payloadOffset), 0);
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
    extractHiddenQRedPayload,
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
