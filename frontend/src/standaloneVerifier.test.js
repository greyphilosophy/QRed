/* @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { createQrFrameScanner } from "./qr/scanQrImage.js";
import * as verifier from "./qredVerifier.js";
import { createQRedSeals } from "./qredSealer.js";
import { createQRedQrSymbol } from "./qredQr.js";
import { readSigningKeyFile } from "./signingKeys.js";

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
    createQrFrameScanner, readSigningKeyFile, ...verifier, decodeQRedSeal: verifier.decodeSeal,
    captureDocumentFrameForOcr: vi.fn(), drawArOverlay: vi.fn(), ...overrides,
  };
  // Execute the shipped module with real QR/signature code. Camera tests
  // supply image pixels; direct verification tests use the existing test API.
  new Function(...Object.keys(bindings), source)(...Object.values(bindings));
}

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = "";
  delete navigator.mediaDevices;
});

it("opens a saved issuer key in the standalone verifier and rejects invalid files without replacing it", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const { seals } = await createQRedSeals({ content: "Standalone imported key", privateKey, publicKey });
  loadStandalone();
  const picker = document.getElementById("publicKeyFileInput");
  fireEvent.change(picker, { target: { files: [{ name: "qred-ed25519-public-key.txt", size: 45, text: async () => publicKey + "\n" }] } });
  await waitFor(() => expect(document.getElementById("publicKeyInput").value).toBe(publicKey.replace(/=$/, "")));
  fireEvent.change(picker, { target: { files: [{ name: "key.txt", size: 3, text: async () => "bad" }] } });
  await waitFor(() => expect(document.getElementById("publicKeyFileStatus").textContent).toContain("Key import failed"));
  expect(document.getElementById("publicKeyInput").value).toBe(publicKey.replace(/=$/, ""));
  await window.__qredTestVerify(seals, document.getElementById("publicKeyInput").value);
  await waitFor(() => expect(document.getElementById("resultStatus").textContent).toBe("VALID"));
  expect(document.getElementById("resultContent").textContent).toBe("Standalone imported key");
  expect(fetch).not.toHaveBeenCalled();
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
  document.getElementById("publicKeyInput").value = publicKey;
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
  document.getElementById("publicKeyInput").value = "Sz8MZnNyHPkt6J3hC_rcXEabv4rrQSgAH_krcitjlF8";
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
