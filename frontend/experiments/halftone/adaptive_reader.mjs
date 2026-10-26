// Experimental Node-only decoder. Nothing here is imported by the web apps.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import QRCode from "qrcode";
import { hiddenPayloadFromScanResult } from "../../src/qr/hiddenPayload.js";
import { verifyQRedSeals } from "../../src/qredVerifier.js";
import { qrPayloadBytes, encodeBase64Url } from "../../src/sealFormat.js";
import { scanQrImage } from "../../src/qr/scanQrImage.js";

function loadInternals(path) {
  // Expose the pinned jsQR 1.4.0 internals IN MEMORY. No installed dependency
  // or production patch is changed. Retain its license in the original bundle.
  const source = readFileSync(path, "utf8");
  const entry = "return __webpack_require__(__webpack_require__.s = 3);";
  if (source.split(entry).length !== 2) throw new Error("Unexpected jsQR bundle layout");
  const replacement = "return { default: { BitMatrix: __webpack_require__(0).BitMatrix, binarize: __webpack_require__(4).binarize, decode: __webpack_require__(5).decode, extract: __webpack_require__(11).extract, locate: __webpack_require__(12).locate } };";
  const module = { exports: {} };
  new Function("module", "exports", source.replace(entry, replacement))(module, module.exports);
  const api = module.exports;
  for (const name of ["BitMatrix", "binarize", "decode", "extract", "locate"]) {
    if (typeof api[name] !== "function") throw new Error(`Missing jsQR internal: ${name}`);
  }
  return api;
}

function conventional(row, col, n) {
  return ((row < 9 && col < 9) || (row < 9 && col >= n - 8)
    || (row >= n - 8 && col < 9) || row === 6 || col === 6
    || (row < 6 && n - 11 <= col && col < n - 8)
    || (col < 6 && n - 11 <= row && row < n - 8)
    || (n - 9 <= row && row <= n - 5 && n - 9 <= col && col <= n - 5));
}

function sample(data, width, height, point) {
  const x = Math.max(0, Math.min(width - 1, Math.floor(point.x)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(point.y)));
  const i = 4 * (y * width + x);
  return .2126 * data[i] + .7152 * data[i + 1] + .0722 * data[i + 2];
}

function median(values) {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

function scanAdaptive(data, width, height, api) {
  // Only the photographed pixels enter this function. No fixture, ground-truth
  // matrix, page bounds, source cover, or rendering transform is available.
  const { binarized } = api.binarize(data, width, height, false);
  const locations = api.locate(binarized) || [];
  let attempted = 0;
  for (const location of locations) for (const delta of [0, -4, 4]) {
    const n = location.dimension + delta;
    if (n < 21 || n > 177 || n % 4 !== 1) continue;
    const version = (n - 17) / 4;
    // Only reserved-cell locations are used; this contains no expected payload.
    const layout = QRCode.create("X", { version, errorCorrectionLevel: "L" }).modules;
    const extracted = api.extract(binarized, { ...location, dimension: n });
    const map = extracted.mappingFunction;
    const dark = [], light = [];
    for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
        const isDark = x === 0 || y === 0 || x === 6 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
        (isDark ? dark : light).push(sample(data, width, height, map(ox + x + .5, oy + y + .5)));
      }
    }
    const black = median(dark), white = median(light);
    if (white - black < 40) continue;
    // The 25%/75% decision boundaries are halfway between nominal 0/50/100
    // tones. Camera gamma, shadows and printer dot gain are NOT calibrated.
    for (const phase of [0, -.08, .08]) {
      attempted++;
      const matrix = api.BitMatrix.createEmpty(n, n);
      for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
        const luma = (sample(data, width, height, map(col + .5 + phase, row + .5 + phase)) - black) / (white - black);
        const value = layout.isReserved(row, col) && conventional(row, col, n)
          ? luma < .5 : luma >= .25 && luma < .75;
        matrix.set(col, row, value);
      }
      const decoded = api.decode(matrix);
      if (decoded) return { code: { data: decoded.text, correctedData: decoded.correctedData,
        binaryData: decoded.bytes, version: decoded.version }, attempted, located: locations.length };
    }
  }
  return { code: null, attempted, located: locations.length };
}

async function main() {
  const [directory, decoderPath] = process.argv.slice(2);
  if (!directory || !decoderPath) throw new Error("Usage: adaptive.cjs OUTPUT_DIRECTORY JSQR_BUNDLE_PATH");
  const api = loadInternals(decoderPath);
  const fixture = JSON.parse(readFileSync(resolve(directory, "fixture.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
  const expected = encodeBase64Url(qrPayloadBytes(fixture.seal));
  const results = [];
  for (const item of manifest.samples) {
    const { data, width, height } = PNG.sync.read(readFileSync(resolve(directory, item.file)));
    const pixels = new Uint8ClampedArray(data);
    const start = performance.now();
    const scan = item.encoding === "binary" ? { code: scanQrImage(pixels, width, height) }
      : scanAdaptive(pixels, width, height, api);
    const seal = hiddenPayloadFromScanResult(scan.code);
    let payloadMatches = false;
    try { payloadMatches = !!seal && encodeBase64Url(qrPayloadBytes(seal)) === expected; } catch {}
    const verified = payloadMatches ? await verifyQRedSeals([seal], fixture.publicKey) : null;
    const result = { ...item, width, height, decoder: item.encoding === "binary" ? "production" : "experimental three-tone",
      payloadMatches, signatureValid: verified?.status === "VALID" && verified?.content === fixture.content,
      locatedCandidates: scan.located, attemptedGrids: scan.attempted, milliseconds: Math.round(performance.now() - start) };
    results.push(result);
    writeFileSync(resolve(directory, "results.json"), JSON.stringify({ total: manifest.samples.length,
      complete: results.length === manifest.samples.length, results }, null, 2));
    console.log(`${item.name}: ${result.signatureValid ? "VALID full seal" : "FAIL"} (${result.milliseconds}ms)`);
  }
  if (results.some(result => result.encoding === "binary" && !result.signatureValid)) throw new Error("A conventional QR control failed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
