/* @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { getPreferredCameraStream, applyCameraQualityControls } from "./qr/cameraControls.js";
import { startCameraSession } from "./qr/cameraSession.js";
import { observePageScanGuide } from "./qr/pageScanGuide.js";
import { canCaptureCameraPhoto, captureCameraPhoto, cameraFrameDiagnostic, cameraCaptureFeedback } from "./qr/cameraPhoto.js";
import { createQrFrameScanner } from "./qr/scanQrImage.js";
import { createLiveScanWorker, scanPhotoInWorker } from "./qr/photoScanClient.js";
import { qrFrameAction } from "./qr/decodePhoto.js";
import * as verifier from "./qredVerifier.js";
import { createQRedSeals } from "./qredSealer.js";
import { createQRedQrData, createQRedQrSymbol } from "./qredQr.js";
import { readSigningKeyFile } from "./signingKeys.js";
import { createVerificationSession } from "./verifier/verificationSession.js";
import { createScanPhotoCollection } from "./verifier/scanPhotos.js";
import { photoProcessingMessage } from "./verifier/photoStatus.js";
import { signAsync } from "@noble/ed25519";
import { AUTH_PROVIDERS, authProvider } from "./authProviders.js";
import { attestationMessage, pageCommitment } from "./attestation.js";
import { decodeBase64Url, encodeBase64Url, qrPayloadBytes } from "./sealFormat.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";

function raster(symbol) {
  const width = (symbol.modules.size + 8) * 5;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < width; y += 1) for (let x = 0; x < width; x += 1) {
    const row = Math.floor(y / 5) - 4;
    const col = Math.floor(x / 5) - 4;
    if (row >= 0 && col >= 0 && row < symbol.modules.size && col < symbol.modules.size && symbol.modules.get(row, col)) {
      const index = (y * width + x) * 4;
      data[index] = data[index + 1] = data[index + 2] = 0;
    }
  }
  return { data, width, height: width };
}

function loadStandalone(overrides = {}) {
  document.documentElement.innerHTML = readFileSync("verifier.html", "utf8");
  const source = document.querySelector('script[type="module"]').textContent.replace(/^\s*import .+;$/gm, "");
  // jsdom has no real Worker. Keep the real client and QR decoder, delivering
  // results asynchronously; the built-browser tests exercise the actual worker.
  vi.stubGlobal("Worker", class {
    scan = (overrides.createQrFrameScanner || createQrFrameScanner)();
    stopped = false;
    postMessage({ image, returnPayload }) {
      const action = qrFrameAction(image, this.scan(image.data, image.width, image.height), { returnPayload });
      queueMicrotask(() => { if (!this.stopped) this.onmessage?.({ data: { action } }); });
    }
    terminate() { this.stopped = true; }
  });
  const bindings = {
    getPreferredCameraStream, applyCameraQualityControls, authProvider, startCameraSession, observePageScanGuide, createLiveScanWorker, readSigningKeyFile, createVerificationSession, ...verifier, decodeQRedSeal: verifier.decodeSeal,
    preparePhotoScanner: vi.fn(), scanPhotoInWorker, photoProcessingMessage, canCaptureCameraPhoto, captureCameraPhoto, cameraFrameDiagnostic, cameraCaptureFeedback,
    createScanPhotoCollection: callback => createScanPhotoCollection(callback, async () => new Blob(["frame"], { type: "image/png" })),
    mountPhotoTextVerification: () => ({ update: vi.fn(), prepare: vi.fn().mockResolvedValue(), clear: vi.fn() }),
    mountPdfSealInput: () => ({ update: vi.fn() }),
    ...overrides,
  };
  // Execute the shipped module with real QR/signature code. Camera tests
  // supply image pixels; direct verification tests use the existing test API.
  new Function(...Object.keys(bindings), source)(...Object.values(bindings));
}

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = "";
  delete navigator.mediaDevices;
});

it.each(Object.keys(AUTH_PROVIDERS))("shows an authenticated %s identity and server time offline with safely escaped names", async provider => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const metadata = { pdf: false, key_id: "da522162396ab2d0", timestamp: "2026-10-20T12:00:00Z",
    identity: { provider, email: "alice@gmail.com", subject: "123", name: "<img src=x onerror=alert(1)>", name_source: provider } };
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const content = "Synthetic attested document";
  const signature = await signAsync(attestationMessage(metadata, await pageCommitment(metadata, content, salt)), decodeBase64Url(privateKey));
  const { seals } = await createQRedSeals({ content,
    attestation: { ...metadata, salt, public_key: publicKey.replace(/=$/, ""), signature: encodeBase64Url(signature) } });
  loadStandalone({ verifyQRedSeals: (items, key) => verifier.verifyQRedSeals(items, key, { [metadata.key_id]: publicKey }) });
  expect(document.getElementById("publicKeyInput")).toBeNull();
  expect(document.getElementById("issuerKeyControls").hidden).toBe(true);
  await window.__qredTestVerify(seals, "");
  expect(document.getElementById("issuerKeyControls").hidden).toBe(true);
  await waitFor(() => expect(document.getElementById("resultStatus").textContent).toBe("Seal authenticated"));
  const details = document.getElementById("resultMeta");
  expect(details.textContent).toContain("alice@gmail.com");
  expect(details.textContent).toContain("Account authenticated through " + authProvider(provider).label);
  expect(details.textContent).toContain("QRed server clock");
  expect(details.textContent).toContain(metadata.identity.name);
  expect(details.querySelector("img")).toBeNull();
  expect(details.textContent.includes("QRed did not separately verify control of that mailbox")).toBe(provider !== "google");
  expect(fetch).not.toHaveBeenCalled();
});

it("opens a saved issuer key in the standalone verifier and rejects invalid files without replacing it", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const { seals } = await createQRedSeals({ content: "Standalone imported key", privateKey, publicKey });
  loadStandalone();
  expect(document.getElementById("issuerKeyControls").hidden).toBe(true);
  await window.__qredTestVerify(seals);
  expect(document.getElementById("resultStatus").textContent).toBe("UNVERIFIED");
  expect(document.getElementById("issuerKeyControls").hidden).toBe(false);
  const picker = document.getElementById("publicKeyFileInput");
  fireEvent.change(picker, { target: { files: [{ name: "qred-ed25519-public-key.txt", size: 45, text: async () => publicKey + "\n" }] } });
  await waitFor(() => expect(document.getElementById("resultStatus").textContent).toBe("Seal authenticated"));
  fireEvent.change(picker, { target: { files: [{ name: "key.txt", size: 3, text: async () => "bad" }] } });
  await waitFor(() => expect(document.getElementById("publicKeyFileStatus").textContent).toContain("Key import failed"));
  await window.__qredTestVerify(seals);
  await waitFor(() => expect(document.getElementById("resultStatus").textContent).toBe("Seal authenticated"));
  expect(document.getElementById("resultContent").textContent).toBe("Standalone imported key");
  expect(fetch).not.toHaveBeenCalled();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ clearRect() {} });
  fireEvent.click(document.getElementById("btnNewScan"));
  expect(document.getElementById("issuerKeyControls").hidden).toBe(true);
});

it("the standalone camera recovers standard byte payloads before verifying and renders metadata safely", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const timestamp = "2026-10-20T17:55:14.123Z";
  const { seals } = await createQRedSeals({ content: "Standalone camera document", timestamp, privateKey, publicKey });
  const frame = raster(createQRedQrSymbol(seals[0]));
  expect(jsQR(frame.data, frame.width, frame.height).binaryData).toEqual(Array.from(qrPayloadBytes(seals[0])));

  loadStandalone();
  const video = document.getElementById("cameraVideo");
  Object.defineProperties(video, { videoWidth: { value: frame.width }, videoHeight: { value: frame.height } });
  vi.spyOn(video, "play").mockResolvedValue();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {}, getImageData: () => frame });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop() {} }] }),
  } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ public_key: publicKey, key_id: "da522162396ab2d0" }) }));
  fireEvent.click(document.getElementById("btnScan"));
  await waitFor(() => expect(typeof video.onloadedmetadata).toBe("function"));
  video.onloadedmetadata();
  await waitFor(() => expect(document.getElementById("resultStatus").textContent).toBe("Seal authenticated"));
  expect(document.getElementById("resultContent").textContent).toBe("Standalone camera document");
  expect(document.getElementById("resultMeta").textContent).toContain(timestamp);
  expect(document.getElementById("resultMeta").querySelector("img")).toBeNull();
});

it("the standalone camera yields between retries and ignores a retired padding payload", async () => {
  vi.stubGlobal("crypto", webcrypto);
  let nextFrame;
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback) => { nextFrame = callback; return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const scan = vi.fn(createQrFrameScanner());
  loadStandalone({ createQrFrameScanner: () => scan });

  const frame = PNG.sync.read(readFileSync("../tests/fixtures/qr-scans/invoice-footer-300dpi.png"));
  const video = document.getElementById("cameraVideo");
  Object.defineProperties(video, { videoWidth: { value: frame.width }, videoHeight: { value: frame.height } });
  vi.spyOn(video, "play").mockResolvedValue();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {}, getImageData: () => frame });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop() {} }] }),
  } });
  fireEvent.click(document.getElementById("btnScan"));
  await waitFor(() => expect(typeof video.onloadedmetadata).toBe("function"));
  video.onloadedmetadata();
  expect(scan).toHaveBeenCalledTimes(1);
  expect(scan.mock.results[0].value).toBeNull();
  await Promise.resolve();

  // Rendering frames during the cooldown must not do more decoding work.
  now += 124;
  nextFrame();
  expect(scan).toHaveBeenCalledTimes(1);
  for (let retry = 0; retry < 3 && !scan.mock.results.at(-1).value; retry += 1) {
    now += 125;
    const callsBefore = scan.mock.calls.length;
    nextFrame();
    expect(scan).toHaveBeenCalledTimes(callsBefore + 1);
    await Promise.resolve();
  }
  expect(document.getElementById("resultStatus").textContent).toBe("");
  expect(document.getElementById("resultContent").textContent).not.toContain("QRED1?");
  expect(document.getElementById("btnScan").textContent).toBe("Stop camera");
  expect(document.getElementById("btnCapture").hidden).toBe(false);
});

it.each([
  { name: "immediate recovery", timestamp: "2026-11-02T05:54:27.000Z" },
  { name: "recovery after a missed frame", timestamp: "2026-10-20T17:55:14.123Z" },
])("keeps one camera session for multipart seals and resolves the default key after reconstruction ($name)", async ({ timestamp }) => {
  vi.stubGlobal("crypto", webcrypto);
  // Fix the signed bytes: a wall-clock timestamp changes the QR pattern and
  // can change which rescaled frame decodes successfully after a duplicate.
  const sealed = await createQRedSeals({ content: "A".repeat(3000), encodingStrategy: "plaintext",
    timestamp, privateKey, publicKey });
  expect(sealed.seals).toHaveLength(2);
  const frames = sealed.seals.map(seal => raster(createQRedQrSymbol(seal)));
  let frame = frames[1], nextFrame, now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", vi.fn(callback => { nextFrame = callback; return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ public_key: publicKey, key_id: sealed.key_id }) }));
  const stop = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }),
  } });
  const scan = vi.fn(createQrFrameScanner());
  loadStandalone({ createQrFrameScanner: () => scan });
  const video = document.getElementById("cameraVideo");
  Object.defineProperties(video, { videoWidth: { value: frame.width }, videoHeight: { value: frame.height } });
  vi.spyOn(video, "play").mockResolvedValue();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {}, getImageData: () => frame });
  fireEvent.click(document.getElementById("btnScan"));
  await waitFor(() => expect(typeof video.onloadedmetadata).toBe("function"));
  video.onloadedmetadata();
  await Promise.resolve();
  expect(document.getElementById("statusText").textContent).toContain("1 of 2 QR seals");
  now += 125; nextFrame();
  await Promise.resolve();
  expect(document.querySelectorAll(".seal-item")).toHaveLength(1);
  expect(stop).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  frame = frames[0];
  // The real camera continues supplying fresh frames after a miss. Exercise
  // that bounded fallback instead of stopping the simulated camera after one
  // attempt and waiting for a result that can no longer arrive.
  for (let retry = 0; retry < 4 && document.querySelectorAll(".seal-item").length < 2; retry++) {
    const callsBefore = scan.mock.calls.length;
    now += 125; nextFrame();
    expect(scan).toHaveBeenCalledTimes(callsBefore + 1);
    await Promise.resolve();
  }
  expect(document.querySelectorAll(".seal-item")).toHaveLength(2);
  await waitFor(() => expect(document.getElementById("resultStatus").textContent).toBe("Seal authenticated"));
  expect(document.getElementById("resultContent").textContent).toBe("A".repeat(3000));
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("collects a page-aligned batch from one live camera frame", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const content = "Four-code camera page. ".repeat(160).trimEnd();
  const sealed = await createQRedSeals({ content, privateKey, publicKey,
    encodingStrategy: "plaintext", preferFourQrPage: true,
    pageContext: { pageNumber: 1, pageCount: 1 } });
  expect(sealed.seals).toHaveLength(4);
  const codes = sealed.seals.map(seal => {
    const { payloadBytes, version } = createQRedQrData(seal);
    return { data: "", binaryData: Array.from(payloadBytes), version };
  });
  const snapshot = vi.fn(async () => new Blob(["frame"], { type: "image/png" }));
  loadStandalone({ createQrFrameScanner: () => () => ({ codes }),
    createScanPhotoCollection: callback => createScanPhotoCollection(callback, snapshot) });
  const frame = { width: 320, height: 240, data: new Uint8ClampedArray(320 * 240 * 4) };
  const video = document.getElementById("cameraVideo");
  Object.defineProperties(video, { videoWidth: { value: frame.width }, videoHeight: { value: frame.height } });
  vi.spyOn(video, "play").mockResolvedValue();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {}, getImageData: () => frame });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop() {} }] }),
  } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ public_key: publicKey, key_id: sealed.key_id }) }));
  fireEvent.click(document.getElementById("btnScan"));
  await waitFor(() => expect(typeof video.onloadedmetadata).toBe("function"));
  video.onloadedmetadata();
  await waitFor(() => expect(document.getElementById("resultStatus").textContent).toBe("Seal authenticated"));
  expect(document.getElementById("resultContent").textContent).toBe(content);
  expect(document.querySelectorAll(".seal-item")).toHaveLength(4);
  expect(snapshot).toHaveBeenCalledTimes(1);
  for (const [source] of snapshot.mock.calls) expect(source).toBe(document.getElementById("scanCanvas"));
});

it("keeps timeout retry guidance after collecting new or duplicate partial camera seals", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const { seals } = await createQRedSeals({ content: "A".repeat(3000), encodingStrategy: "plaintext",
    timestamp: "2026-11-04T12:00:00Z", privateKey, publicKey });
  expect(seals).toHaveLength(2);
  let callbacks;
  const reset = vi.fn(), retry = vi.fn().mockResolvedValue({ status: "feedback", message: "Retry finished." });
  loadStandalone({
    createLiveScanWorker: options => {
      callbacks = options;
      return { busy: false, reset, scan: vi.fn(), stop: vi.fn() };
    },
    startCameraSession: () => ({ stop: vi.fn() }),
    scanPhotoInWorker: retry,
    canCaptureCameraPhoto: () => false,
  });
  const video = document.getElementById("cameraVideo");
  Object.defineProperties(video, { videoWidth: { value: 20 }, videoHeight: { value: 30 } });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {}, getImageData: () => ({}) });
  fireEvent.click(document.getElementById("btnScan"));
  await waitFor(() => expect(callbacks).toBeDefined());
  const action = { status: "found-multiple", texts: [seals[0]], timedOut: true,
    message: "The photo scan reached its time limit. Use Capture now to try again." };
  const retained = document.getElementById("scanCanvas");
  retained.width = 20; retained.height = 30;
  callbacks.onCaptured();
  callbacks.onResult(action);
  await waitFor(() => expect(document.querySelectorAll(".seal-item")).toHaveLength(1));
  expect(document.getElementById("statusText").textContent).toContain("1 of 2 QR seals");
  expect(document.getElementById("pageGuideHint").textContent).toContain(action.message);
  expect(document.getElementById("pageGuideHint").textContent).toContain("Camera frame: 20 × 30");
  callbacks.onResult(action);
  expect(document.getElementById("pageGuideHint").textContent).toContain(action.message);
  expect(document.getElementById("pageGuideHint").textContent).toContain("Camera frame: 20 × 30");
  const capture = document.getElementById("btnCapture");
  expect(capture.hidden).toBe(false);
  expect(capture.textContent).toBe("Capture now");
  fireEvent.click(capture);
  await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
  expect(reset).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(document.getElementById("pageGuideHint").textContent).toContain("Retry finished."));
});


it("shows a mixed-document warning instead of an all-authenticated summary for a current cover and older results", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const timestamp = "2026-11-04T12:00:00.000Z";
  const makePage = (pageNumber, documentRoot, content) => createQRedSeals({
    privateKey, publicKey, timestamp, content,
    pageContext: { pageNumber, pageCount: 2, documentRoot },
  });
  const cover = await makePage(1, "a1".repeat(32), "Current cover letter");
  const currentResults = await makePage(2, "a1".repeat(32), "Current results");
  const oldResults = await makePage(2, "b2".repeat(32), "Older results");
  loadStandalone();
  await window.__qredTestVerify([...cover.seals, ...oldResults.seals], publicKey);
  expect(document.getElementById("resultStatus").textContent).toBe("Mixed document pages");
  expect(document.getElementById("resultStatus").classList.contains("valid")).toBe(false);
  const progress = document.querySelector(".collection-progress").textContent;
  expect(progress).toContain("different documents or signing versions");
  expect(progress).toContain("1 of 2 pages collected");
  expect(progress).not.toContain("All 2 pages collected");
  expect([...document.querySelectorAll(".verification-result h3")].map(heading => heading.textContent))
    .toEqual(["Page 1 of 2 · Seal authenticated", "Page 2 of 2 · Seal authenticated"]);

  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ clearRect() {} });
  fireEvent.click(document.getElementById("btnNewScan"));
  await window.__qredTestVerify([...cover.seals, ...currentResults.seals], publicKey);
  expect(document.getElementById("resultStatus").textContent).toBe("Seal authenticated");
  expect(document.querySelector(".collection-progress").textContent).toBe("All 2 pages collected.");
});

it("uses native still pixels and shows their dimensions after a standalone camera timeout", async () => {
  const pixels = { width: 40, height: 60, data: new Uint8ClampedArray(40 * 60 * 4) };
  const bitmap = { width: 40, height: 60, close: vi.fn() };
  vi.stubGlobal("ImageCapture", vi.fn(function () { return { takePhoto: () => Promise.resolve(new Blob()) }; }));
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  const scan = vi.fn().mockResolvedValue({ status: "feedback", timedOut: true, message: "The scan reached its time limit." });
  loadStandalone({ startCameraSession: () => ({ stop: vi.fn() }), scanPhotoInWorker: scan,
    createLiveScanWorker: () => ({ busy: false, reset: vi.fn(), scan: vi.fn(), stop: vi.fn() }) });
  const video = document.getElementById("cameraVideo");
  video.srcObject = { getVideoTracks: () => [{ kind: "video", readyState: "live" }] };
  Object.defineProperties(video, { videoWidth: { value: 20 }, videoHeight: { value: 30 } });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {}, getImageData: () => pixels });
  fireEvent.click(document.getElementById("btnScan"));
  await waitFor(() => expect(document.getElementById("btnCapture").hidden).toBe(false));
  fireEvent.click(document.getElementById("btnCapture"));
  await waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
  expect(scan.mock.calls[0][0]).toBe(pixels);
  expect(document.getElementById("scanCanvas").width).toBe(40);
  expect(document.getElementById("scanCanvas").height).toBe(60);
  await waitFor(() => expect(document.getElementById("pageGuideHint").textContent).toContain("Camera photo: 40 × 60"));
});
