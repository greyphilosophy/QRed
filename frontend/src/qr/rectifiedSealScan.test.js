import { expect, it, vi } from "vitest";
import QRCode from "qrcode";
import { createQRedSeals } from "../qredSealer.js";
import { createQRedQrData } from "../qredQr.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { pageWatermarkRegions } from "./pageAlignedScan.js";
import { scanRectifiedSeal, createRectifiedSealScanner, prepareCurvedPageScan } from "./rectifiedSealScan.js";
import * as moduleSamples from "./rectifiedModuleSamples.js";
import * as pageGeometry from "./pageAlignedScan.js";
import * as watermarkFilter from "./watermarkFilter.js";
import * as recovery from "./pageAlignedRecovery.js";

const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";

// A generated page, not a retained photograph. Grain grows in the darker
// part of the sheet, making a high-percentile paper estimate brighter than
// the exposed white modules. One global threshold then confuses them with
// pale ink elsewhere. The decoder receives only these camera-like pixels.
function shadowedPrint(symbol, grain, { bow = 0, overprint = false, cornerBend = 0 } = {}) {
  const scale = overprint ? 2 : 1;
  const width = 1000 * scale, height = 1300 * scale, data = new Uint8ClampedArray(width * height * 4);
  const paper = { x: 50 * scale, y: 50 * scale, width: 900 * scale, height: 1165 * scale };
  const region = pageWatermarkRegions(1, undefined, { marginPoints: 54 })[0];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = (x - paper.x) / paper.width, py = (y - paper.y) / paper.height;
    const bend = cornerBend * Math.max(0, (px - .45) / .55) ** 2 * Math.max(0, (py - .45) / .55) ** 2;
    const u = px + bend, v = py - bow * (2 * px - 1) ** 2 + bend * .65;
    let value = 80;
    if (bow) value += 55 * Math.max(0, Math.cos(30 * y / height - 7 * x / width)) ** 10;
    if (u >= 0 && v >= 0 && u < 1 && v < 1) {
      const col = Math.floor((u - region.x) / region.width * symbol.modules.size);
      const row = Math.floor((v - region.y) / region.height * symbol.modules.size);
      const inside = col >= 0 && row >= 0 && col < symbol.modules.size && row < symbol.modules.size;
      const dark = inside && symbol.modules.get(row, col);
      const illumination = 240 * (1 - v * 0.45);
      const noise = ((Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663)) >>> 0) % 1000 / 999 * 2 - 1;
      value = illumination * (dark ? 0.87 - 0.12 * v : 1) + noise * (2 + grain * v);
      if (inside && row > 15 && row < 125 && row % 19 === 0 && col % 4 !== 0) value = 40;
      if (overprint && inside) {
        const moduleY = (v - region.y) / region.height * symbol.modules.size;
        if (row > 14 && row < 125 && row % 12 === 4 && col % 7 < 4 && moduleY - row < .7) value = 45;
        // A light navigation panel covers part of the top-right finder.
        if (col >= symbol.modules.size - 7 && col <= symbol.modules.size - 2 && row >= 2 && row < 4)
          value = illumination;
      }
    }
    const at = (y * width + x) * 4;
    data[at] = bow ? value * 1.1 : value;
    data[at + 1] = value;
    data[at + 2] = bow ? value * .9 : value;
    data[at + 3] = 255;
  }
  return { data, width, height };
}

it("authenticates a bowed warm-lit print against a ridged background from pixels alone", async () => {
  const { seals } = await createQRedSeals({
    privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", publicKey,
    content: "Synthetic bowed print. ".repeat(40), encodingStrategy: "plaintext",
    timestamp: "2026-11-04T12:00:00Z",
  });
  const { payloadBytes } = createQRedQrData(seals[0]);
  const symbol = QRCode.create([{ data: payloadBytes, mode: "byte" }], { version: 31, errorCorrectionLevel: "L" });
  const image = shadowedPrint(symbol, 8, { bow: .018 });
  const alternative = prepareCurvedPageScan(image, null, () => true);
  expect(alternative?.preferred).toBe(true);
  const result = alternative.scan({ searchRadius: 12 });
  expect(result?.seal).toBe(seals[0]);
  await expect(verifyQRedSeals([result.seal], publicKey)).resolves.toMatchObject({
    status: "VALID", signature_valid: true,
  });
}, 20000);

it("authenticates a seal with an overprinted finder and dark strokes crossing the data", async () => {
  const { seals } = await createQRedSeals({
    privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", publicKey,
    content: "Synthetic overprinted watermark. ".repeat(30), encodingStrategy: "plaintext",
    timestamp: "2026-11-11T12:00:00Z",
  });
  const { payloadBytes } = createQRedQrData(seals[0]);
  const symbol = QRCode.create([{ data: payloadBytes, mode: "byte" }], { version: 31, errorCorrectionLevel: "L" });
  const image = shadowedPrint(symbol, 8, { overprint: true });
  const recover = vi.spyOn(recovery, "recoverSampledQrMatrix");
  let result;
  try {
    result = scanRectifiedSeal(image, { searchRadius: 12 });
    const exposed = recover.mock.calls.findIndex(([, , , options]) => options?.bitReliability);
    expect(exposed).toBeGreaterThanOrEqual(0);
    expect(recover.mock.results[exposed].value?.seal).toBe(seals[0]);
  } finally { recover.mockRestore(); }
  expect(result?.seal).toBe(seals[0]);
  await expect(verifyQRedSeals([result.seal], publicKey)).resolves.toMatchObject({ status: "VALID", signature_valid: true });
  await expect(verifyQRedSeals([result.seal], "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI"))
    .resolves.toMatchObject({ status: "INVALID" });
}, 20000);

it("authenticates an overprinted seal when one corner of the paper bends inward", async () => {
  const { seals } = await createQRedSeals({
    privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", publicKey,
    content: "Invoice line 100.50, item 42. ".repeat(30), encodingStrategy: "plaintext",
    timestamp: "2026-11-11T12:00:00Z",
  });
  const { payloadBytes } = createQRedQrData(seals[0]);
  const symbol = QRCode.create([{ data: payloadBytes, mode: "byte" }], { version: 31, errorCorrectionLevel: "L" });
  const image = shadowedPrint(symbol, 8, { cornerBend: .065, overprint: true });
  const result = scanRectifiedSeal(image, { searchRadius: 12 });
  expect(result?.seal).toBe(seals[0]);
  await expect(verifyQRedSeals([result.seal], publicKey)).resolves.toMatchObject({ status: "VALID", signature_valid: true });
  await expect(verifyQRedSeals([result.seal], "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI"))
    .resolves.toMatchObject({ status: "INVALID" });
}, 20000);

it.each([25, 29])("recovers a shadowed print with grain %i through real finder fitting and local retries", async grain => {
  const { seals } = await createQRedSeals({
    privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", publicKey,
    content: "Synthetic image-level local contrast recovery. ".repeat(30),
    encodingStrategy: "plaintext", timestamp: "2026-11-04T12:00:00Z",
  });
  const { payloadBytes } = createQRedQrData(seals[0]);
  const symbol = QRCode.create([{ data: payloadBytes, mode: "byte" }], {
    version: 31, errorCorrectionLevel: "L",
  });
  const image = shadowedPrint(symbol, grain), original = image.data.slice();
  // Observe calls without replacing the pixel classifier or any geometry.
  const classify = vi.spyOn(moduleSamples, "classifyLocalModuleSamples");
  const samples = vi.spyOn(moduleSamples, "collectModuleSamples");
  let result;
  try {
    result = scanRectifiedSeal(image, { searchRadius: 12 });
    if (grain === 29) expect(classify.mock.calls.some(([, options]) => options.thresholdFraction === 0.4)).toBe(true);
    if (grain === 25) expect(samples.mock.calls.every(([, width, height]) => width === 900 && height === 900)).toBe(true);
  } finally { classify.mockRestore(); samples.mockRestore(); }
  expect(result?.seal).toBe(seals[0]);
  expect(image.data.every((value, index) => value === original[index])).toBe(true);
  await expect(verifyQRedSeals([result.seal], publicKey)).resolves.toMatchObject({
    status: "VALID", signature_valid: true,
  });
}, 20000);

it.each([false, true])("recovers original pixels after rectified evidence is lost (edge retry %s)", async sharpOnly => {
  const { seals } = await createQRedSeals({
    privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", publicKey,
    content: "Synthetic native-pixel retry. ".repeat(30), encodingStrategy: "plaintext",
    timestamp: "2026-11-04T12:00:00Z",
  });
  const { payloadBytes } = createQRedQrData(seals[0]);
  const symbol = QRCode.create([{ data: payloadBytes, mode: "byte" }], {
    version: 31, errorCorrectionLevel: "L",
  });
  const image = shadowedPrint(symbol, 0), original = image.data.slice();
  const collect = moduleSamples.collectModuleSamples;
  let nativeCalls = 0;
  const samples = vi.spyOn(moduleSamples, "collectModuleSamples").mockImplementation((gray, width, height, map, version) => {
    const observations = collect(gray, width, height, map, version);
    // Model evidence lost during rectification, without substituting any
    // expected bits into the retry. The source photograph remains intact.
    if (width === 900 || (sharpOnly && ++nativeCalls === 1)) observations.values.fill(0);
    return observations;
  });
  let result;
  try {
    result = scanRectifiedSeal(image, { searchRadius: 12 });
    expect(samples.mock.calls.map(([, width, height]) => [width, height]))
      .toEqual([[900, 900], [image.width, image.height],
        ...(sharpOnly ? [[image.width, image.height]] : [])]);
  } finally { samples.mockRestore(); }
  expect(result?.seal).toBe(seals[0]);
  expect(image.data.every((value, index) => value === original[index])).toBe(true);
  expect(result.code.location.bottomRightCorner.y).toBeGreaterThan(900);
  await expect(verifyQRedSeals([result.seal], publicKey)).resolves.toMatchObject({
    status: "VALID", signature_valid: true,
  });
  await expect(verifyQRedSeals([result.seal], "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI"))
    .resolves.toMatchObject({ status: "INVALID" });
}, 20000);

it("does not start native sampling after the shared deadline expires", async () => {
  const { seals } = await createQRedSeals({
    privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", publicKey,
    content: "Synthetic native-pixel deadline. ".repeat(30), encodingStrategy: "plaintext",
    timestamp: "2026-11-04T12:00:00Z",
  });
  const { payloadBytes } = createQRedQrData(seals[0]);
  const symbol = QRCode.create([{ data: payloadBytes, mode: "byte" }], {
    version: 31, errorCorrectionLevel: "L",
  });
  let running = true;
  const collect = moduleSamples.collectModuleSamples;
  const samples = vi.spyOn(moduleSamples, "collectModuleSamples").mockImplementation((...args) => {
    const observations = collect(...args);
    running = false;
    return observations;
  });
  try {
    expect(scanRectifiedSeal(shadowedPrint(symbol, 0), {
      searchRadius: 12, shouldContinue: () => running,
    })).toBeNull();
    expect(samples).toHaveBeenCalledTimes(1);
    expect(samples.mock.calls[0].slice(1, 3)).toEqual([900, 900]);
  } finally { samples.mockRestore(); }
}, 20000);

it("reuses measured preparation across narrow and wide attempts on one frozen photo only", async () => {
  const { seals } = await createQRedSeals({
    privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", publicKey,
    content: "Synthetic request-local preparation. ".repeat(30), encodingStrategy: "plaintext",
    timestamp: "2026-11-04T12:00:00Z",
  });
  const { payloadBytes } = createQRedQrData(seals[0]);
  const symbol = QRCode.create([{ data: payloadBytes, mode: "byte" }], { version: 31, errorCorrectionLevel: "L" });
  const image = shadowedPrint(symbol, 0), original = image.data.slice();
  const locate = vi.spyOn(pageGeometry, "locatePaper");
  const normalize = vi.spyOn(watermarkFilter, "normalizeWatermarkLuminance");
  try {
    const scan = createRectifiedSealScanner(image);
    // Construction and an already-expired call do no pixel work.
    expect(scan({ shouldContinue: () => false })).toBeNull();
    expect(locate).not.toHaveBeenCalled();
    expect(scan({ searchRadius: 12 })?.seal).toBe(seals[0]);
    const preparedCount = normalize.mock.calls.length;
    expect(preparedCount).toBeGreaterThan(0);
    expect(scan({ searchRadius: 39 })?.seal).toBe(seals[0]);
    expect(locate).toHaveBeenCalledTimes(1);
    expect(normalize).toHaveBeenCalledTimes(preparedCount);
    expect(image.data.every((value, index) => value === original[index])).toBe(true);
    // Even identical source pixels in another request get independent state.
    expect(createRectifiedSealScanner(image)({ searchRadius: 12 })?.seal).toBe(seals[0]);
    expect(locate).toHaveBeenCalledTimes(2);
    expect(normalize).toHaveBeenCalledTimes(preparedCount * 2);
  } finally { locate.mockRestore(); normalize.mockRestore(); }
}, 20000);

it("retains completed native normalization after a narrow deadline without starting sharpening", async () => {
  const { seals } = await createQRedSeals({
    privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", publicKey,
    content: "Synthetic interrupted native preparation. ".repeat(30), encodingStrategy: "plaintext",
    timestamp: "2026-11-04T12:00:00Z",
  });
  const { payloadBytes } = createQRedQrData(seals[0]);
  const symbol = QRCode.create([{ data: payloadBytes, mode: "byte" }], { version: 31, errorCorrectionLevel: "L" });
  const image = shadowedPrint(symbol, 0), nativeBuffers = [];
  let running = true;
  const collect = moduleSamples.collectModuleSamples;
  const samples = vi.spyOn(moduleSamples, "collectModuleSamples").mockImplementation((gray, width, ...args) => {
    const observed = collect(gray, width, ...args);
    if (width === image.width) { nativeBuffers.push(gray); running = false; }
    return observed;
  });
  const decode = vi.spyOn(recovery, "recoverSampledQrMatrix").mockReturnValue(null);
  const normalize = vi.spyOn(watermarkFilter, "normalizeWatermarkLuminance");
  const sharpen = vi.spyOn(moduleSamples, "sharpenModuleLuminance");
  try {
    const scan = createRectifiedSealScanner(image);
    expect(scan({ searchRadius: 12, shouldContinue: () => running })).toBeNull();
    running = true;
    expect(scan({ searchRadius: 39, shouldContinue: () => running })).toBeNull();
    expect(nativeBuffers).toHaveLength(2);
    expect(nativeBuffers[1]).toBe(nativeBuffers[0]);
    expect(normalize.mock.calls.filter(([, width]) => width === image.width)).toHaveLength(1);
    expect(sharpen).not.toHaveBeenCalled();
  } finally { samples.mockRestore(); decode.mockRestore(); normalize.mockRestore(); sharpen.mockRestore(); }
}, 20000);

it("does not repeatedly locate absent paper in the same request", () => {
  const image = { width: 180, height: 180, data: new Uint8ClampedArray(180 * 180 * 4).fill(255) };
  const locate = vi.spyOn(pageGeometry, "locatePaper");
  try {
    const scan = createRectifiedSealScanner(image);
    expect(scan({ searchRadius: 12 })).toBeNull();
    expect(scan({ searchRadius: 39 })).toBeNull();
    expect(locate).toHaveBeenCalledTimes(1);
  } finally { locate.mockRestore(); }
});
