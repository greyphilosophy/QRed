/* @vitest-environment jsdom */
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import jsQR from "jsqr";
import * as verifier from "./qredVerifier.js";
import { createQRedSeals } from "./qredSealer.js";
import { createQRedQrSymbol } from "./qredQr.js";

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

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

it("the standalone camera recovers hidden payload bytes before verifying and renders metadata safely", async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const issuer = '<img src=x onerror="alert(1)">';
  const { seals } = await createQRedSeals({ content: "Standalone camera document", issuer, privateKey, publicKey });
  const frame = raster(createQRedQrSymbol(seals[0]));
  expect(jsQR(frame.data, frame.width, frame.height).data).toBe("QRED.ORG");

  const html = readFileSync("verifier.html", "utf8");
  document.documentElement.innerHTML = html;
  const source = document.querySelector('script[type="module"]').textContent.replace(/^\s*import .+;$/gm, "");
  const bindings = {
    jsQR, ...verifier, decodeQRedSeal: verifier.decodeSeal,
    captureDocumentFrameForOcr: vi.fn(), drawArOverlay: vi.fn(),
  };
  // Execute the shipped inline module, with real QR/signature code and a fake
  // camera frame. No test verification hook or pre-decoded seal is injected.
  new Function(...Object.keys(bindings), source)(...Object.values(bindings));
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
  expect(document.getElementById("resultMeta").textContent).toContain(issuer);
  expect(document.getElementById("resultMeta").querySelector("img")).toBeNull();
});
