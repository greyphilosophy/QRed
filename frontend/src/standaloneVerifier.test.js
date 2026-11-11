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
import { readCameraFrame, captureCameraPhoto, readCameraPhotoFile, cameraPhotoFailure, cameraFrameDiagnostic, cameraCaptureFeedback, cameraCaptureContext } from "./qr/cameraPhoto.js";
import { createQrFrameScanner } from "./qr/scanQrImage.js";
import { createLiveScanWorker, scanPhotoInWorker } from "./qr/photoScanClient.js";
import { mountPhotoScanProgress } from "./qr/mountPhotoScanProgress.js";
import { qrFrameAction } from "./qr/decodePhoto.js";
import * as verifier from "./qredVerifier.js";
import { createQRedSeals } from "./qredSealer.js";
import { createQRedQrData, createQRedQrSymbol } from "./qredQr.js";
import { readSigningKeyFile } from "./signingKeys.js";
import { createVerificationSession } from "./verifier/verificationSession.js";
import { createScanPhotoCollection } from "./verifier/scanPhotos.js";
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

const progressMounts = [];
function loadStandalone(overrides = {}) {
  document.documentElement.innerHTML = readFileSync("verifier.html", "utf8");
  const source = document.querySelector('script[type="module"]').textContent.replace(/^\s*import .+;$/gm, "");
  // jsdom has no real Worker. Keep the real client and QR decoder, delivering
  // results asynchronously; the built-browser tests exercise the actual worker.
  // This legacy QR harness deliberately returns decoded preview results. Native
  // acquisition tests below use explicit captureOnly callbacks and assert that
  // the shipped UI never submits preview pixels to the photo decoder.
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
    preparePhotoScanner: vi.fn(), scanPhotoInWorker, readCameraFrame, captureCameraPhoto, readCameraPhotoFile, cameraPhotoFailure, cameraFrameDiagnostic, cameraCaptureFeedback, cameraCaptureContext,
    createScanPhotoCollection: callback => createScanPhotoCollection(callback, async () => new Blob(["frame"], { type: "image/png" })),
    mountPhotoTextVerification: () => ({ update: vi.fn(), prepare: vi.fn().mockResolvedValue(), clear: vi.fn() }),
    mountPdfSealInput: () => ({ update: vi.fn() }),
    mountPhotoScanProgress: element => {
      const progress = mountPhotoScanProgress(element);
      progressMounts.push(progress);
      return progress;
    },
    ...overrides,
  };
  // Execute the shipped module with real QR/signature code. Camera tests
  // supply image pixels; direct verification tests use the existing test API.
  new Function(...Object.keys(bindings), source)(...Object.values(bindings));
}

afterEach(() => {
  progressMounts.splice(0).forEach(progress => progress.dispose());
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = "";
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
    captureCameraPhoto: async (video, canvas, options) => {
      canvas.width = 2000; canvas.height = 3000;
      options.onDiagnostic({ source: "native-still", width: 2000, height: 3000, reason: "captured" });
      return { width: 2000, height: 3000, data: new Uint8ClampedArray(4) };
    },
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

it.each(["manual", "automatic"])("keeps %s trigger and guide metadata after a standalone camera timeout", async mode => {
  const pixels = { width: 2000, height: 3000, data: new Uint8ClampedArray(4) };
  const bitmap = { width: 2000, height: 3000, close: vi.fn() };
  vi.stubGlobal("ImageCapture", vi.fn(function () { return { takePhoto: () => Promise.resolve(new Blob()) }; }));
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue(bitmap));
  const scan = vi.fn().mockResolvedValue({ status: "feedback", timedOut: true, message: "The scan reached its time limit." });
  let callbacks;
  loadStandalone({ startCameraSession: () => ({ stop: vi.fn() }), scanPhotoInWorker: scan,
    createLiveScanWorker: options => {
      callbacks = options;
      return { busy: false, reset: vi.fn(), scan: vi.fn(), stop: vi.fn() };
    } });
  const video = document.getElementById("cameraVideo");
  video.srcObject = { getVideoTracks: () => [{ kind: "video", readyState: "live" }] };
  Object.defineProperties(video, { videoWidth: { value: 20 }, videoHeight: { value: 30 } });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {}, getImageData: () => pixels });
  fireEvent.click(document.getElementById("btnScan"));
  await waitFor(() => expect(document.getElementById("btnCapture").hidden).toBe(false));
  callbacks.onQuality({ state: mode === "manual" ? "soft" : "ready", message: "Safe guide.", progress: mode === "manual" ? 0 : 1 });
  if (mode === "manual") fireEvent.click(document.getElementById("btnCapture"));
  else callbacks.onCaptured({ captureOnly: true });
  await waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
  expect(scan.mock.calls[0][0]).toBe(pixels);
  // Native acquisition uses its own canvas, never the preview canvas.
  expect(document.getElementById("scanCanvas").width).toBe(300);
  expect(document.getElementById("scanCanvas").height).toBe(150);
  await waitFor(() => expect(document.getElementById("pageGuideHint").textContent).toContain("Camera photo: 2000 × 3000"));
  expect(document.getElementById("pageGuideHint").textContent)
    .toContain(`${mode} capture, 20 × 30 preview, last guide: ${mode === "manual" ? "page edges soft" : "steady hold passed"}`);
});

function setupStandaloneCapture(overrides = {}) {
  const live = { busy: false, reset: vi.fn(), scan: vi.fn(), stop: vi.fn() };
  const scan = vi.fn().mockResolvedValue({ status: "feedback", message: "No seal in this photo." });
  let callbacks, camera;
  loadStandalone({
    createLiveScanWorker: options => { callbacks = options; return live; },
    startCameraSession: options => { camera = options; return { stop: vi.fn() }; },
    scanPhotoInWorker: scan,
    ...overrides,
  });
  const video = document.getElementById("cameraVideo");
  const track = { kind: "video", readyState: "live" };
  video.srcObject = { getVideoTracks: () => [track] };
  Object.defineProperties(video, { videoWidth: { value: 800 }, videoHeight: { value: 1000 } });
  const pixels = { width: 2000, height: 3000, data: new Uint8ClampedArray(4) };
  const context = { drawImage: vi.fn(), getImageData: vi.fn(() => pixels) };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  return { live, scan, pixels, context, get callbacks() { return callbacks; }, get camera() { return camera; } };
}
function selectedStandalonePhoto({ width = 2000, height = 3000, decode = () => Promise.resolve() } = {}) {
  const image = { naturalWidth: width, naturalHeight: height, decode, src: "" };
  vi.stubGlobal("Image", vi.fn(function () { return image; }));
  URL.createObjectURL = vi.fn(() => "blob:synthetic-page");
  URL.revokeObjectURL = vi.fn();
  return image;
}
it.each(["native capture", "photo decoding"])("resumes quality guidance and automatic native capture after cancelling %s", async stage => {
  let finish;
  const capture = vi.fn();
  const setup = setupStandaloneCapture({ captureCameraPhoto: capture });
  capture.mockResolvedValue(setup.pixels);
  if (stage === "native capture") capture.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  else setup.scan.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(document.getElementById("btnScan"));
  await waitFor(() => expect(setup.camera).toBeDefined());
  fireEvent.click(document.getElementById("btnCapture"));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  const signal = capture.mock.calls[0][2].signal;
  const scansBeforeCancel = setup.scan.mock.calls.length;
  const resetsBeforeCancel = setup.live.reset.mock.calls.length;
  fireEvent.click(document.getElementById("btnCapture"));
  expect(signal.aborted).toBe(true);
  expect(document.getElementById("btnCapture").textContent).toBe("Capture now");
  expect(setup.live.reset).toHaveBeenCalledTimes(resetsBeforeCancel + 1);
  setup.camera.onFrame();
  expect(setup.live.scan).toHaveBeenCalledTimes(1);
  expect(setup.live.scan.mock.calls[0][1]).toEqual({ captureOnly: true });
  expect(setup.scan).toHaveBeenCalledTimes(scansBeforeCancel);
  finish(stage === "native capture" ? setup.pixels : { status: "feedback", message: "Cancelled result must stay hidden." });
  await Promise.resolve(); await Promise.resolve();
  expect(setup.scan).toHaveBeenCalledTimes(scansBeforeCancel);
  expect(document.getElementById("pageGuideHint").textContent).not.toContain("Cancelled result");
  setup.callbacks.onQuality({ state: "hold", message: "Hold steady.", progress: .5 });
  expect(document.getElementById("pageGuideHint").textContent).toBe("Hold steady.");
  // A new stable-page signal takes a real still without another shutter tap.
  setup.callbacks.onCaptured({ captureOnly: true });
  await waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(setup.scan).toHaveBeenCalledTimes(scansBeforeCancel + 1));
  expect(capture.mock.calls[1][2]).toMatchObject({ requireHighResolution: true });
  expect(setup.scan.mock.calls.at(-1)[0]).toBe(setup.pixels);
});
it("keeps automatic capture paused while the explicit photo picker is open", async () => {
  const capture = vi.fn().mockResolvedValue(null);
  const setup = setupStandaloneCapture({ captureCameraPhoto: capture });
  fireEvent.click(document.getElementById("btnScan"));
  await waitFor(() => expect(setup.camera).toBeDefined());
  fireEvent.click(document.getElementById("btnChoosePhoto"));
  setup.camera.onFrame();
  setup.callbacks.onCaptured({ captureOnly: true });
  expect(setup.live.scan).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled();
  expect(setup.scan).not.toHaveBeenCalled();
});
it("resumes guidance and automatic native capture after dismissing the photo picker", async () => {
  const capture = vi.fn();
  const setup = setupStandaloneCapture({ captureCameraPhoto: capture });
  capture.mockResolvedValue(setup.pixels);
  fireEvent.click(document.getElementById("btnScan"));
  await waitFor(() => expect(setup.camera).toBeDefined());
  fireEvent.click(document.getElementById("btnChoosePhoto"));
  document.getElementById("pagePhotoInput").dispatchEvent(new Event("cancel"));
  setup.camera.onFrame();
  expect(setup.live.scan).toHaveBeenCalledTimes(1);
  expect(setup.live.scan.mock.calls[0][1]).toEqual({ captureOnly: true });
  expect(capture).not.toHaveBeenCalled();
  setup.callbacks.onCaptured({ captureOnly: true });
  await waitFor(() => expect(setup.scan).toHaveBeenCalledTimes(1));
  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture.mock.calls[0][2]).toMatchObject({ requireHighResolution: true });
});
it.each([false, true])("ignores a stale picker dismissal when another picker is open (restarted session: %s)", async restart => {
  const capture = vi.fn();
  const setup = setupStandaloneCapture({ captureCameraPhoto: capture });
  fireEvent.click(document.getElementById("btnScan"));
  await waitFor(() => expect(setup.camera).toBeDefined());
  fireEvent.click(document.getElementById("btnChoosePhoto"));
  const input = document.getElementById("pagePhotoInput"), staleCancel = input.oncancel;
  if (restart) {
    const oldCamera = setup.camera;
    document.getElementById("photoTextComparison").scrollIntoView = vi.fn();
    fireEvent.click(document.getElementById("btnScan"));
    fireEvent.click(document.getElementById("btnScan"));
    await waitFor(() => expect(setup.camera).not.toBe(oldCamera));
  }
  fireEvent.click(document.getElementById("btnChoosePhoto"));
  const currentCancel = input.oncancel;
  staleCancel();
  expect(input.oncancel).toBe(currentCancel);
  setup.camera.onFrame();
  setup.callbacks.onCaptured({ captureOnly: true });
  expect(setup.live.scan).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled();
  input.dispatchEvent(new Event("cancel"));
  setup.camera.onFrame();
  expect(setup.live.scan).toHaveBeenCalledTimes(1);
  expect(setup.live.scan.mock.calls[0][1]).toEqual({ captureOnly: true });
});
it("does not resume a camera when dismissing a picker in a photo-only session", async () => {
  const capture = vi.fn();
  const setup = setupStandaloneCapture({ captureCameraPhoto: capture });
  selectedStandalonePhoto();
  fireEvent.change(document.getElementById("pagePhotoInput"), { target: { files: [new File(["synthetic"], "page.jpg")] } });
  await waitFor(() => expect(setup.scan).toHaveBeenCalledTimes(1));
  const resets = setup.live.reset.mock.calls.length;
  fireEvent.click(document.getElementById("btnChoosePhoto"));
  document.getElementById("pagePhotoInput").dispatchEvent(new Event("cancel"));
  expect(setup.camera).toBeUndefined();
  expect(setup.live.reset).toHaveBeenCalledTimes(resets);
  expect(setup.live.scan).not.toHaveBeenCalled();
  expect(capture).not.toHaveBeenCalled();
});
it.each(["unsupported", "too small", "rejected"])("never decodes standalone preview pixels when native capture is %s", async failure => {
  if (failure !== "unsupported") {
    vi.stubGlobal("ImageCapture", vi.fn(function () { return { takePhoto: () => failure === "rejected"
      ? Promise.reject(new Error("camera failed")) : Promise.resolve(new Blob()) }; }));
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 1200, height: 1600, close: vi.fn() }));
  }
  const setup = setupStandaloneCapture();
  fireEvent.click(document.getElementById("btnScan"));
  await waitFor(() => expect(setup.camera).toBeDefined());
  setup.camera.onFrame();
  expect(setup.live.scan.mock.calls[0][1]).toEqual({ captureOnly: true });
  setup.callbacks.onCaptured({ captureOnly: true });
  await waitFor(() => expect(document.getElementById("pageGuideHint").textContent).toContain("No video frame was scanned"));
  expect(setup.scan).not.toHaveBeenCalled();
  expect(setup.context.drawImage).toHaveBeenCalledTimes(1);
  expect(setup.live.reset).not.toHaveBeenCalled();
  setup.callbacks.onQuality({ state: "captured", message: "Move the page.", progress: 0 });
  expect(document.getElementById("pageGuideHint").textContent).toContain("No video frame was scanned");
  expect(document.getElementById("btnChoosePhoto").hidden).toBe(false);
});
it("bounds a standalone native timeout and ignores its eventual photo", async () => {
  let finish;
  vi.stubGlobal("ImageCapture", vi.fn(function () { return { takePhoto: () => new Promise(resolve => { finish = resolve; }) }; }));
  vi.stubGlobal("createImageBitmap", vi.fn());
  const setup = setupStandaloneCapture();
  fireEvent.click(document.getElementById("btnScan"));
  await waitFor(() => expect(setup.camera).toBeDefined());
  vi.useFakeTimers();
  fireEvent.click(document.getElementById("btnCapture"));
  await vi.advanceTimersByTimeAsync(5000);
  expect(document.getElementById("pageGuideHint").textContent).toContain("did not finish taking its photo in time");
  expect(setup.scan).not.toHaveBeenCalled();
  finish(new Blob()); await Promise.resolve(); await Promise.resolve();
  expect(setup.context.drawImage).not.toHaveBeenCalled();
  expect(createImageBitmap).not.toHaveBeenCalled();
});
it("verifies and retains a selected high-resolution photo without requiring camera access", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const sealed = await createQRedSeals({ content: "Selected document", privateKey, publicKey });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ public_key: publicKey, key_id: sealed.key_id }) }));
  const snapshot = vi.fn(async () => new Blob(["photo"]));
  const setup = setupStandaloneCapture({ createScanPhotoCollection: callback => createScanPhotoCollection(callback, snapshot) });
  setup.scan.mockResolvedValue({ status: "found", text: sealed.seals[0] });
  const image = selectedStandalonePhoto();
  fireEvent.change(document.getElementById("pagePhotoInput"), { target: { files: [new File(["synthetic"], "page.jpg", { type: "image/jpeg" })] } });
  await waitFor(() => expect(document.getElementById("resultStatus").textContent).toBe("Seal authenticated"));
  expect(document.getElementById("resultContent").textContent).toBe("Selected document");
  expect(setup.scan.mock.calls[0][0]).toBe(setup.pixels);
  expect(setup.camera).toBeUndefined();
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(setup.context.drawImage).toHaveBeenCalledWith(image, 0, 0, 2000, 3000);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-page");
});
it("retries a native failure with an explicitly selected photo and preserves selected dimensions", async () => {
  const setup = setupStandaloneCapture(); selectedStandalonePhoto();
  fireEvent.click(document.getElementById("btnScan"));
  await waitFor(() => expect(setup.camera).toBeDefined());
  fireEvent.click(document.getElementById("btnCapture"));
  await waitFor(() => expect(document.getElementById("pageGuideHint").textContent).toContain("No video frame was scanned"));
  fireEvent.change(document.getElementById("pagePhotoInput"), { target: { files: [new File(["synthetic"], "page.jpg")] } });
  await waitFor(() => expect(setup.scan).toHaveBeenCalledTimes(1));
  expect(document.getElementById("pageGuideHint").textContent).toContain("Selected photo: 2000 × 3000");
});
it("clears a pending selected photo without letting its late pixels revive the session", async () => {
  let finish;
  const setup = setupStandaloneCapture();
  selectedStandalonePhoto({ decode: () => new Promise(resolve => { finish = resolve; }) });
  fireEvent.change(document.getElementById("pagePhotoInput"), { target: { files: [new File(["synthetic"], "page.jpg")] } });
  fireEvent.click(document.getElementById("btnNewScan"));
  finish(); await Promise.resolve(); await Promise.resolve();
  expect(setup.scan).not.toHaveBeenCalled(); expect(setup.context.drawImage).not.toHaveBeenCalled();
  expect(document.getElementById("scanCanvas").width).toBe(0);
  expect(document.getElementById("clearNotice").textContent).toBe("Check cleared. Camera off.");
});
it("cancels native capture and accepts a replacement file without publishing the old shot", async () => {
  let finish;
  vi.stubGlobal("ImageCapture", vi.fn(function () { return { takePhoto: () => new Promise(resolve => { finish = resolve; }) }; }));
  vi.stubGlobal("createImageBitmap", vi.fn());
  const setup = setupStandaloneCapture(); selectedStandalonePhoto();
  fireEvent.click(document.getElementById("btnScan"));
  await waitFor(() => expect(setup.camera).toBeDefined());
  fireEvent.click(document.getElementById("btnCapture"));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  fireEvent.change(document.getElementById("pagePhotoInput"), { target: { files: [new File(["synthetic"], "page.jpg")] } });
  await waitFor(() => expect(setup.scan).toHaveBeenCalledTimes(1));
  finish(new Blob()); await Promise.resolve(); await Promise.resolve();
  expect(setup.scan).toHaveBeenCalledTimes(1); expect(createImageBitmap).not.toHaveBeenCalled();
  expect(document.getElementById("pageGuideHint").textContent).toContain("Selected photo: 2000 × 3000");
});

it("rejects a too-small selected standalone photo before decoding it", async () => {
  const setup = setupStandaloneCapture(); selectedStandalonePhoto({ width: 1200, height: 1600 });
  fireEvent.change(document.getElementById("pagePhotoInput"), { target: { files: [new File(["synthetic"], "small.jpg")] } });
  await waitFor(() => expect(document.getElementById("pageGuideHint").textContent).toContain("at least 4 MP and 2560 pixels"));
  expect(setup.scan).not.toHaveBeenCalled(); expect(setup.context.drawImage).not.toHaveBeenCalled();
});
it("replaces a pending standalone photo selection without changing the latest result", async () => {
  let finish;
  const setup = setupStandaloneCapture(); selectedStandalonePhoto();
  const oldImage = { naturalWidth: 2000, naturalHeight: 3000, decode: () => new Promise(resolve => { finish = resolve; }), src: "" };
  Image.mockImplementationOnce(function () { return oldImage; });
  const input = document.getElementById("pagePhotoInput");
  fireEvent.change(input, { target: { files: [new File(["old"], "old.jpg")] } });
  fireEvent.change(input, { target: { files: [new File(["new"], "new.jpg")] } });
  await waitFor(() => expect(setup.scan).toHaveBeenCalledTimes(1));
  finish(); await Promise.resolve(); await Promise.resolve();
  expect(setup.scan).toHaveBeenCalledTimes(1);
  expect(setup.context.drawImage).toHaveBeenCalledTimes(1);
  expect(setup.context.drawImage.mock.calls[0][0]).not.toBe(oldImage);
  expect(document.getElementById("pageGuideHint").textContent).toContain("Selected photo: 2000 × 3000");
});

it.each(["manual", "automatic"])("shows live stages through %s native acquisition and clears them on completion", async mode => {
  let finishCapture, finishScan;
  const setup = setupStandaloneCapture({
    captureCameraPhoto: () => new Promise(resolve => { finishCapture = resolve; }),
  });
  setup.scan.mockImplementation(() => new Promise(resolve => { finishScan = resolve; }));
  fireEvent.click(document.getElementById("btnScan"));
  await waitFor(() => expect(setup.camera).toBeDefined());
  if (mode === "manual") fireEvent.click(document.getElementById("btnCapture"));
  else setup.callbacks.onCaptured({ captureOnly: true });
  const progress = progressMounts.at(-1);
  const target = document.getElementById("photoScanProgress");
  expect(progress.getSnapshot().label).toMatch(/photo/i);
  expect(target.hidden).toBe(false);
  const hint = document.getElementById("pageGuideHint");
  expect(hint.hidden).toBe(true);
  const priorHint = hint.textContent;
  setup.callbacks.onQuality({ state: "hold", message: "Busy guidance must not replace the stage.", progress: .5 });
  expect(hint.textContent).toBe(priorHint);
  finishCapture(setup.pixels);
  await waitFor(() => expect(setup.scan).toHaveBeenCalledTimes(1));
  const onStage = setup.scan.mock.calls[0][1].onStage;
  onStage({ stage: "footer", elapsedMs: 750 });
  expect(progress.getSnapshot().label).toMatch(/footer/i);
  expect(target.textContent).toMatch(/footer/i);
  expect(hint.hidden).toBe(true);
  expect(hint.textContent).not.toMatch(/processing|taking photo|opening photo/i);
  expect(target.querySelector('[role="progressbar"], progress')).not.toBeNull();
  finishScan({ status: "feedback", message: "No seal found." });
  await waitFor(() => expect(progress.getSnapshot()).toBeNull());
  expect(target.hidden).toBe(true);
  expect(hint.hidden).toBe(false);
  expect(hint.textContent).toBe("No seal found.");
  onStage({ stage: "general-qr", elapsedMs: 900 });
  expect(progress.getSnapshot()).toBeNull();
});

it("shows selected-photo opening and ignores late stages and completion after replacement or clear", async () => {
  const openings = [], scans = [];
  const setup = setupStandaloneCapture({
    readCameraPhotoFile: () => new Promise(resolve => openings.push(resolve)),
    scanPhotoInWorker: (pixels, options) => new Promise(resolve => scans.push({ options, resolve })),
  });
  const input = document.getElementById("pagePhotoInput");
  const choose = name => fireEvent.change(input, { target: { files: [new File(["photo"], name)] } });
  choose("first.jpg");
  const progress = progressMounts.at(-1);
  const openingLabel = progress.getSnapshot().label;
  expect(openingLabel).toMatch(/open/i);
  openings[0](setup.pixels);
  await waitFor(() => expect(scans).toHaveLength(1));
  scans[0].options.onStage({ stage: "footer", elapsedMs: 100 });
  expect(progress.getSnapshot().label).toMatch(/footer/i);
  choose("second.jpg");
  expect(scans[0].options.signal.aborted).toBe(true);
  expect(progress.getSnapshot().label).toBe(openingLabel);
  scans[0].options.onStage({ stage: "general-qr", elapsedMs: 200 });
  scans[0].resolve({ status: "feedback", message: "Old result" });
  await Promise.resolve(); await Promise.resolve();
  expect(progress.getSnapshot().label).toBe(openingLabel);
  openings[1](setup.pixels);
  await waitFor(() => expect(scans).toHaveLength(2));
  scans[1].options.onStage({ stage: "page-aligned", elapsedMs: 300 });
  expect(progress.getSnapshot().label).toMatch(/layout/i);
  fireEvent.click(document.getElementById("btnNewScan"));
  expect(progress.getSnapshot()).toBeNull();
  scans[1].options.onStage({ stage: "general-qr", elapsedMs: 400 });
  scans[1].resolve({ status: "feedback", message: "Cleared result" });
  await Promise.resolve(); await Promise.resolve();
  expect(progress.getSnapshot()).toBeNull();
  expect(document.getElementById("photoScanProgress").hidden).toBe(true);
});

it.each(["cancel", "stop", "error", "capture failure", "scan failure", "timeout"])(
  "clears standalone photo progress on %s", async ending => {
    let finishCapture, finishScan, rejectScan;
    const setup = setupStandaloneCapture({
      captureCameraPhoto: () => new Promise(resolve => { finishCapture = resolve; }),
    });
    setup.scan.mockImplementation(() => new Promise((resolve, reject) => { finishScan = resolve; rejectScan = reject; }));
    fireEvent.click(document.getElementById("btnScan"));
    await waitFor(() => expect(setup.camera).toBeDefined());
    fireEvent.click(document.getElementById("btnCapture"));
    const progress = progressMounts.at(-1);
    expect(progress.getSnapshot()).not.toBeNull();
    if (ending === "capture failure") finishCapture(null);
    else {
      finishCapture(setup.pixels);
      await waitFor(() => expect(setup.scan).toHaveBeenCalledTimes(1));
      setup.scan.mock.calls[0][1].onStage({ stage: "footer", elapsedMs: 100 });
      if (ending === "cancel") fireEvent.click(document.getElementById("btnCapture"));
      if (ending === "stop") {
        document.getElementById("photoTextComparison").scrollIntoView = vi.fn();
        fireEvent.click(document.getElementById("btnScan"));
      }
      if (ending === "error") setup.callbacks.onError(new Error("Camera unavailable"));
      if (ending === "scan failure") rejectScan(new Error("Scan unavailable"));
      if (ending === "timeout") finishScan({ status: "feedback", timedOut: true, message: "Retry this photo." });
    }
    await waitFor(() => expect(progress.getSnapshot()).toBeNull());
    expect(document.getElementById("photoScanProgress").hidden).toBe(true);
    const hint = document.getElementById("pageGuideHint");
    expect(hint.hidden).toBe(["stop", "error"].includes(ending));
    if (ending === "scan failure") expect(hint.textContent).toBe("Scan unavailable");
    if (ending === "timeout") expect(hint.textContent).toBe("Retry this photo.");
    if (ending === "capture failure") expect(hint.textContent).toContain("No video frame was scanned");
    if (finishScan && !["scan failure", "timeout"].includes(ending)) {
      setup.scan.mock.calls[0][1].onStage({ stage: "general-qr", elapsedMs: 500 });
      finishScan({ status: "feedback", message: "Late result" });
      await Promise.resolve(); await Promise.resolve();
      expect(progress.getSnapshot()).toBeNull();
    }
  },
);

it("reports live-worker stages only for its active capture", async () => {
  const setup = setupStandaloneCapture();
  fireEvent.click(document.getElementById("btnScan"));
  await waitFor(() => expect(setup.camera).toBeDefined());
  const progress = progressMounts.at(-1);
  setup.callbacks.onStage({ stage: "footer", elapsedMs: 10 });
  expect(progress.getSnapshot()).toBeNull();
  setup.callbacks.onCaptured();
  setup.callbacks.onStage({ stage: "footer", elapsedMs: 20 });
  expect(progress.getSnapshot().label).toMatch(/footer/i);
  setup.callbacks.onResult({ status: "feedback", message: "Try another page." });
  expect(progress.getSnapshot()).toBeNull();
  setup.callbacks.onStage({ stage: "general-qr", elapsedMs: 30 });
  expect(progress.getSnapshot()).toBeNull();
});
