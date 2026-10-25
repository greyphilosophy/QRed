/* @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { startCameraSession } from "./qr/cameraSession.js";
import { createQrFrameScanner } from "./qr/scanQrImage.js";
import { isQRedEntryLink } from "./qr/hiddenPayload.js";
import * as verifier from "./qredVerifier.js";
import { createQRedSeals } from "./qredSealer.js";
import { createQRedQrSymbol } from "./qredQr.js";
import { readSigningKeyFile } from "./signingKeys.js";
import { createVerificationSession } from "./verifier/verificationSession.js";
import { createScanPhotoCollection } from "./verifier/scanPhotos.js";
import { signAsync } from "@noble/ed25519";
import { attestationMessage, pageCommitment } from "./attestation.js";
import { decodeBase64Url, encodeBase64Url } from "./sealFormat.js";

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
  const bindings = {
    startCameraSession, createQrFrameScanner, isQRedEntryLink, readSigningKeyFile, createVerificationSession, ...verifier, decodeQRedSeal: verifier.decodeSeal,
    createScanPhotoCollection: callback => createScanPhotoCollection(callback, async () => new Blob(["frame"], { type: "image/png" })),
    mountPhotoTextVerification: () => ({ update: vi.fn() }),
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

it("shows an authenticated Google identity and server time offline with safely escaped names", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const metadata = { pdf: false, key_id: "da522162396ab2d0", timestamp: "2026-10-20T12:00:00Z",
    identity: { provider: "google", email: "alice@gmail.com", subject: "123", name: "<img src=x onerror=alert(1)>", name_source: "google" } };
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
  await waitFor(() => expect(document.getElementById("resultStatus").textContent).toBe("VALID"));
  const details = document.getElementById("resultMeta");
  expect(details.textContent).toContain("alice@gmail.com");
  expect(details.textContent).toContain("Account authenticated through Google");
  expect(details.textContent).toContain("QRed server clock");
  expect(details.textContent).toContain(metadata.identity.name);
  expect(details.querySelector("img")).toBeNull();
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
  await waitFor(() => expect(document.getElementById("resultStatus").textContent).toBe("VALID"));
  fireEvent.change(picker, { target: { files: [{ name: "key.txt", size: 3, text: async () => "bad" }] } });
  await waitFor(() => expect(document.getElementById("publicKeyFileStatus").textContent).toContain("Key import failed"));
  await window.__qredTestVerify(seals);
  await waitFor(() => expect(document.getElementById("resultStatus").textContent).toBe("VALID"));
  expect(document.getElementById("resultContent").textContent).toBe("Standalone imported key");
  expect(fetch).not.toHaveBeenCalled();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ clearRect() {} });
  fireEvent.click(document.getElementById("btnNewScan"));
  expect(document.getElementById("issuerKeyControls").hidden).toBe(true);
});

it("the standalone camera recovers hidden payload bytes before verifying and renders metadata safely", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const timestamp = "2026-10-20T17:55:14.123Z";
  const { seals } = await createQRedSeals({ content: "Standalone camera document", timestamp, privateKey, publicKey });
  const frame = raster(createQRedQrSymbol(seals[0]));
  expect(jsQR(frame.data, frame.width, frame.height).data).toBe("QRED.ORG");

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
  await waitFor(() => expect(document.getElementById("resultStatus").textContent).toBe("VALID"));
  expect(document.getElementById("resultContent").textContent).toBe("Standalone camera document");
  expect(document.getElementById("resultMeta").textContent).toContain(timestamp);
  expect(document.getElementById("resultMeta").querySelector("img")).toBeNull();
});

it("the standalone camera yields between retries and recovers a historical frame without verifying its retired format", async () => {
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

  // Rendering frames during the cooldown must not do more decoding work.
  now += 124;
  nextFrame();
  expect(scan).toHaveBeenCalledTimes(1);
  for (let retry = 0; retry < 3 && !scan.mock.results.at(-1).value; retry += 1) {
    now += 125;
    const callsBefore = scan.mock.calls.length;
    nextFrame();
    expect(scan).toHaveBeenCalledTimes(callsBefore + 1);
  }
  await waitFor(() => expect(document.getElementById("resultStatus").textContent).toBe("QR_CONTENT"));
  expect(document.getElementById("resultContent").textContent).toContain("QRED1?");
});

it("keeps one camera session for multipart seals and resolves the default key after reconstruction", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const sealed = await createQRedSeals({ content: "A".repeat(3000), encodingStrategy: "plaintext", privateKey, publicKey });
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
  loadStandalone();
  const video = document.getElementById("cameraVideo");
  Object.defineProperties(video, { videoWidth: { value: frame.width }, videoHeight: { value: frame.height } });
  vi.spyOn(video, "play").mockResolvedValue();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {}, getImageData: () => frame });
  fireEvent.click(document.getElementById("btnScan"));
  await waitFor(() => expect(typeof video.onloadedmetadata).toBe("function"));
  video.onloadedmetadata();
  expect(document.getElementById("statusText").textContent).toContain("1 of 2 QR seals");
  now += 125; nextFrame();
  expect(document.querySelectorAll(".seal-item")).toHaveLength(1);
  expect(stop).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  frame = frames[0]; now += 125; nextFrame();
  await waitFor(() => expect(document.getElementById("resultStatus").textContent).toBe("VALID"));
  expect(document.getElementById("resultContent").textContent).toBe("A".repeat(3000));
  expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});
