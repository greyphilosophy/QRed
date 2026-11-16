import { expect, it, vi } from "vitest";
import QRCode from "qrcode";
import { createQRedQrData } from "../qredQr.js";
import { createQRedSeals } from "../qredSealer.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { classifyShadowedModules, recoverShadowedGrid } from "./shadowedModules.js";
import * as shadowGrid from "./shadowedGrid.js";
import * as recovery from "./pageAlignedRecovery.js";

async function shadowedPrint({ mottledCenters = false } = {}) {
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
    let gray = panel ? exposure * (col % 3 === 1 && row % 3 === 1 ? .25 : 1)
      : exposure * (symbol.modules.get(row, col) ? .88 : 1);
    if (mottledCenters && !panel && (17 * col + 23 * row + 13 * col * row) % 101 < 16) {
      const u = (x - 6) % pitch + .5 - pitch / 2, v = (y - 6) % pitch + .5 - pitch / 2;
      if (Math.max(Math.abs(u), Math.abs(v)) < 2) gray = exposure * (symbol.modules.get(row, col) ? 1 : .88);
    }
    const at = (y * side + x) * 4;
    image.data[at] = image.data[at + 1] = image.data[at + 2] = gray;
  }
  return { image, pitch, size, version, publicKey, seal: seals[0] };
}

it("reads the measured grid without refitting cells that already recover the signed payload", async () => {
  const { image, pitch, version, publicKey, seal } = await shadowedPrint();
  const measured = (col, row) => ({ x: 6 + pitch * col, y: 6 + pitch * row });
  const refine = vi.spyOn(shadowGrid, "refineShadowGrid");
  try {
    const result = recoverShadowedGrid(image, measured, version, () => true);
    expect(refine).not.toHaveBeenCalled();
    expect(result?.seal).toBe(seal);
    await expect(verifyQRedSeals([result.seal], publicKey)).resolves.toMatchObject({ status: "VALID", signature_valid: true });
  } finally { refine.mockRestore(); }
});

it("refits a displaced grid to recover a signed watermark across a shadow and an opaque panel", async () => {
  const { image, pitch, size, version, publicKey, seal } = await shadowedPrint();
  const guess = (col, row) => ({
    x: 6 + pitch * col + .5 * pitch * Math.sin(row / size * Math.PI),
    y: 6 + pitch * row + .4 * pitch * Math.sin(col / size * Math.PI),
  });
  expect(shadowGrid.refineShadowGrid(image, guess, version, () => false)).toBeNull();
  const refine = vi.spyOn(shadowGrid, "refineShadowGrid");
  try {
    const result = recoverShadowedGrid(image, guess, version, () => true);
    expect(refine).toHaveBeenCalledOnce();
    expect(result?.seal).toBe(seal);
    await expect(verifyQRedSeals([result.seal], publicKey)).resolves.toMatchObject({ status: "VALID", signature_valid: true });
  } finally { refine.mockRestore(); }
  const flat = new Float32Array((size * shadowGrid.SAMPLES) ** 2).fill(180);
  expect(classifyShadowedModules(flat, size, () => true)).toBeNull();
}, 20000);

it("recovers a signed print when the two grid fits lose detail on different sides", async () => {
  const { image, pitch, size, version, publicKey, seal } = await shadowedPrint();
  // Each fit drifts across cell edges on one half of the same photographed symbol.
  const fit = side => (col, row) => ({
    x: 6 + pitch * (col + .6 * Math.max(0, side * Math.sin(2 * Math.PI * col / size))),
    y: 6 + pitch * row,
  });
  const refine = vi.spyOn(shadowGrid, "refineShadowGrid").mockReturnValue(fit(-1));
  const decode = vi.spyOn(recovery, "recoverSampledQrMatrix");
  try {
    const result = recoverShadowedGrid(image, fit(1), version, () => true);
    expect(decode.mock.results.map(read => read.value?.seal)).toEqual([undefined, undefined, seal]);
    expect(result?.seal).toBe(seal);
    await expect(verifyQRedSeals([result.seal], publicKey)).resolves.toMatchObject({ signature_valid: true });
  } finally {
    refine.mockRestore();
    decode.mockRestore();
  }
}, 20000);

it("uses intact module edges when mottled centers exhaust the first three readings", async () => {
  const { image, pitch, version, seal, publicKey } = await shadowedPrint({ mottledCenters: true });
  const aligned = (col, row) => ({ x: 6 + pitch * col, y: 6 + pitch * row });
  // Hold the physical registration fixed so only the cell classifier changes.
  const refine = vi.spyOn(shadowGrid, "refineShadowGrid").mockReturnValue(aligned);
  const decode = vi.spyOn(recovery, "recoverSampledQrMatrix");
  try {
    const recovered = recoverShadowedGrid(image, aligned, version, () => true);
    expect(decode.mock.results.map(read => read.value?.seal)).toEqual([undefined, undefined, undefined, seal]);
    await expect(verifyQRedSeals([recovered.seal], publicKey)).resolves.toMatchObject({ signature_valid: true });
  } finally {
    refine.mockRestore();
    decode.mockRestore();
  }
}, 20000);
