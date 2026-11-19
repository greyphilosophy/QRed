import { expect, it, vi } from "vitest";
import QRCode from "qrcode";
import { createQRedSeals } from "../qredSealer.js";
import { createQRedQrData } from "../qredQr.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { shadowedPrint } from "./testSupport/shadowedPrint.js";
import { scanRectifiedSeal, createRectifiedSealScanner, prepareCurvedPageScan } from "./rectifiedSealScan.js";
import * as moduleSamples from "./rectifiedModuleSamples.js";
import * as pageGeometry from "./pageAlignedScan.js";
import * as watermarkFilter from "./watermarkFilter.js";
import * as recovery from "./pageAlignedRecovery.js";
import * as shadowGrid from "./shadowedGrid.js";

const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";


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

it("recovers a bowed, shaded print when optional grid remeasurement is unavailable", async () => {
  const { seals } = await createQRedSeals({
    privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", publicKey,
    content: "Synthetic soft-surface print. ".repeat(40), encodingStrategy: "plaintext",
    timestamp: "2026-11-18T12:00:00Z",
  });
  const { payloadBytes } = createQRedQrData(seals[0]);
  const symbol = QRCode.create([{ data: payloadBytes, mode: "byte" }], { version: 33, errorCorrectionLevel: "L" });
  const image = shadowedPrint(symbol, 20, { bow: .018, cornerBend: .065, overprint: true, panelSize: 35 });
  // Initial public-pattern measurements already describe the bend. Further
  // remeasurement can fail on covered marks; keep the actual pixel readers,
  // parity recovery and signature verification, but make that refit unavailable.
  const refit = vi.spyOn(shadowGrid, "refineShadowGrid").mockReturnValue(null);
  let result;
  try {
    result = prepareCurvedPageScan(image, null, () => true)?.scan({ searchRadius: 12 });
  } finally { refit.mockRestore(); }
  expect(result?.seal).toBe(seals[0]);
  await expect(verifyQRedSeals([result.seal], publicKey)).resolves.toMatchObject({
    status: "VALID", signature_valid: true,
  });
}, 20000);

async function overprintedWatermark(panelSize) {
  const { seals } = await createQRedSeals({
    privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", publicKey,
    content: "Synthetic overprinted watermark. ".repeat(30), encodingStrategy: "plaintext",
    timestamp: "2026-11-11T12:00:00Z",
  });
  const { payloadBytes } = createQRedQrData(seals[0]);
  const symbol = QRCode.create([{ data: payloadBytes, mode: "byte" }], { version: 31, errorCorrectionLevel: "L" });
  return { image: shadowedPrint(symbol, 8, { overprint: true, panelSize }), seal: seals[0] };
}

it.each([0, 25, 35])("authenticates a shaded overprinted watermark (opaque panel width %i)", async panelSize => {
  const { image, seal } = await overprintedWatermark(panelSize);
  const recover = vi.spyOn(recovery, "recoverSampledQrMatrix");
  let result;
  try {
    result = scanRectifiedSeal(image, { searchRadius: 12 });
    const exposed = recover.mock.calls.findIndex(([, , , options]) => options?.bitReliability);
    expect(exposed).toBeGreaterThanOrEqual(0);
    if (panelSize) {
      expect(recover.mock.results[exposed].value).toBeNull();
      const shadowReads = recover.mock.calls.flatMap(([, , , options], index) =>
        options?.rankedOutliers ? [index] : []);
      expect(shadowReads).toHaveLength(1);
      expect(shadowReads[0]).toBeGreaterThan(exposed);
      expect(recover.mock.results[shadowReads[0]].value?.seal).toBe(seal);
    } else {
      expect(recover.mock.results[exposed].value?.seal).toBe(seal);
    }
  } finally { recover.mockRestore(); }
  expect(result?.seal).toBe(seal);
  await expect(verifyQRedSeals([result.seal], publicKey)).resolves.toMatchObject({ status: "VALID", signature_valid: true });
  await expect(verifyQRedSeals([result.seal], "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI"))
    .resolves.toMatchObject({ status: "INVALID" });
}, 20000);

it("retries an interrupted shadow read and skips a completed miss for the same page layout", async () => {
  const { image } = await overprintedWatermark(35);
  const scan = createRectifiedSealScanner(image);
  let running = true;
  // Exercise the interruption and cache behavior even on a now-readable print.
  const miss = vi.spyOn(recovery, "recoverSampledQrMatrix").mockReturnValue(null);
  const refine = vi.spyOn(shadowGrid, "refineShadowGrid").mockReturnValue(null)
    .mockImplementationOnce(() => { running = false; return null; });
  const collect = moduleSamples.collectModuleSamples;
  const samples = vi.spyOn(moduleSamples, "collectModuleSamples").mockImplementation((data, width, ...args) => {
    if (width === 900) running = false;
    return collect(data, width, ...args);
  });
  try {
    for (const [searchRadius, calls] of [[12, 1], [39, 2], [39, 2]]) {
      running = true;
      expect(scan({ searchRadius, shouldContinue: () => running })).toBeNull();
      expect(refine).toHaveBeenCalledTimes(calls);
    }
  } finally { samples.mockRestore(); refine.mockRestore(); miss.mockRestore(); }
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
