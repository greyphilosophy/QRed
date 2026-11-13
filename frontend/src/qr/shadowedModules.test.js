import { expect, it } from "vitest";
import QRCode from "qrcode";
import { createQRedQrData } from "../qredQr.js";
import { createQRedSeals } from "../qredSealer.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { recoverSampledQrMatrix } from "./pageAlignedRecovery.js";
import { classifyShadowedModules } from "./shadowedModules.js";
import { refineShadowGrid, sampleGrid } from "./shadowedGrid.js";

it("reads a signed pale watermark across a shadow and an opaque print panel", async () => {
  const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";
  const { seals } = await createQRedSeals({
    privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", publicKey,
    content: "Generated print fixture, line 42.", encodingStrategy: "plaintext",
    timestamp: "2026-11-13T12:00:00Z",
  });
  const version = 21, symbol = QRCode.create([{ data: createQRedQrData(seals[0]).payloadBytes, mode: "byte" }],
    { version, errorCorrectionLevel: "L" });
  const size = symbol.modules.size, pitch = 10, side = size * pitch + 12;
  const image = { width: side, height: side, data: new Uint8ClampedArray(side * side * 4).fill(255) };
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const col = Math.floor((x - 6) / pitch), row = Math.floor((y - 6) / pitch);
    if (col < 0 || row < 0 || col >= size || row >= size) continue;
    const exposure = 115 + 110 / (1 + Math.exp(-(x - .55 * y - .18 * side) / 15));
    const panel = col > size - 23 && col < size - 12 && row > 3 && row < 12;
    const gray = panel ? exposure * (col % 3 === 1 && row % 3 === 1 ? .25 : 1)
      : exposure * (symbol.modules.get(row, col) ? .88 : 1);
    const at = (y * side + x) * 4;
    image.data[at] = image.data[at + 1] = image.data[at + 2] = gray;
  }
  const guess = (col, row) => ({
    x: 6 + pitch * col + 2.5 * Math.sin(row / size * Math.PI),
    y: 6 + pitch * row + 2 * Math.sin(col / size * Math.PI),
  });
  expect(refineShadowGrid(image, guess, version, () => false)).toBeNull();
  const map = refineShadowGrid(image, guess, version, () => true);
  expect(map).toBeTypeOf("function");
  const pixels = sampleGrid(image, map, size, () => true);
  const observed = classifyShadowedModules(pixels, size, () => true);
  const result = recoverSampledQrMatrix(observed, map, version, { bitReliability: observed.reliability, rankedOutliers: true });
  expect(result?.seal).toBe(seals[0]);
  await expect(verifyQRedSeals([result.seal], publicKey)).resolves.toMatchObject({ status: "VALID", signature_valid: true });
  expect(classifyShadowedModules(pixels.fill(180), size, () => true)).toBeNull();
}, 20000);
