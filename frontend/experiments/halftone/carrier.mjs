// Experimental harness only. This is not imported by either production app.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { createQRedSeals, canonicalizeText } from "../../src/qredSealer.js";
import { createQRedQrSymbol, qredPayloadCapacity } from "../../src/qredQr.js";
import { scanQrImage } from "../../src/qr/scanQrImage.js";
import { hiddenPayloadFromScanResult } from "../../src/qr/hiddenPayload.js";
import { verifyQRedSeals } from "../../src/qredVerifier.js";
import { qrPayloadBytes, encodeBase64Url } from "../../src/sealFormat.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes"; // Published QRed demo key only.
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";
async function main() {
  const [mode, directory] = process.argv.slice(2);
  if (!directory || !["prepare", "scan"].includes(mode)) throw new Error("Usage: carrier.cjs prepare|scan OUTPUT_DIRECTORY");
  mkdirSync(directory, { recursive: true });
  if (mode === "prepare") {
    const rows = ["SYNTHETIC QRED CAPACITY TEST - DEMO SIGNATURE ONLY"];
    for (let i = 1; i < 80; i++) rows.push(`${String(i).padStart(3, "0")}  Account ${String(i * 137).padStart(7, "0")}  Amount ${String(i * 631)}.25  Ref ${Math.imul(i + 17, 2654435761) >>> 0}  Route WA${i % 9} Approved`);
    const limit = qredPayloadCapacity(40) - 85;
    let content = canonicalizeText(rows.join("\n").slice(0, limit));
    content += "X".repeat(limit - new TextEncoder().encode(content).length);
    const sealed = await createQRedSeals({ content, privateKey, publicKey,
      pageContext: { pageNumber: 1, pageCount: 1 }, timestamp: "2026-10-25T00:00:00.000Z", encodingStrategy: "plaintext" });
    const symbol = createQRedQrSymbol(sealed.seals[0]);
    if (sealed.seals.length !== 1 || symbol.version !== 40 || sealed.payload_bytes !== qredPayloadCapacity(40)) throw new Error("Fixture must fill exactly one QR40");
    const fixture = { version: symbol.version, modules: symbol.modules.size, payloadBytes: sealed.payload_bytes,
      errorCorrection: "L", publicKey, content, seal: sealed.seals[0],
      matrix: Array.from(symbol.modules.data),
      reserved: Array.from(symbol.modules.data, (_, i) => Boolean(symbol.modules.isReserved(Math.floor(i / symbol.modules.size), i % symbol.modules.size))) };
    writeFileSync(resolve(directory, "fixture.json"), JSON.stringify(fixture));
    console.log(JSON.stringify({ version: fixture.version, modules: fixture.modules, payloadBytes: fixture.payloadBytes }));
    return;
  }
  const fixture = JSON.parse(readFileSync(resolve(directory, "fixture.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
  const expected = encodeBase64Url(qrPayloadBytes(fixture.seal));
  const results = [];
  for (const sample of manifest.samples) {
    const { data, width, height } = PNG.sync.read(readFileSync(resolve(directory, sample.file)));
    const pixels = new Uint8ClampedArray(data);
    const start = performance.now();
    let code = scanQrImage(pixels, width, height, { tryRescaling: false, tryWatermark: false });
    let recovered = hiddenPayloadFromScanResult(code);
    const exact = value => Boolean(value) && encodeBase64Url(qrPayloadBytes(value)) === expected;
    const firstPass = exact(recovered);
    if (!firstPass) {
      code = scanQrImage(pixels, width, height);
      recovered = hiddenPayloadFromScanResult(code);
    }
    const payloadMatches = exact(recovered);
    const verification = payloadMatches ? await verifyQRedSeals([recovered], fixture.publicKey) : null;
    const result = { ...sample, width, height, firstPass, payloadMatches,
      signatureValid: verification?.status === "VALID" && verification?.content === fixture.content,
      visibleText: code?.data || null, milliseconds: Math.round(performance.now() - start) };
    results.push(result);
    // Persist progress as well as failures; a partial run cannot look complete.
    writeFileSync(resolve(directory, "results.json"), JSON.stringify({ total: manifest.samples.length, complete: results.length === manifest.samples.length, results }, null, 2));
    console.log(`${sample.name}: ${result.signatureValid ? "VALID full seal" : "FAIL"} (${firstPass ? "first pass" : "full scanner retries"}; ${result.milliseconds}ms)`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
