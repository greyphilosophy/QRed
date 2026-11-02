import { expect, it } from "vitest";
import { createQRedSeals } from "../qredSealer.js";
import { createQRedQrSymbol } from "../qredQr.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { recoverRefinedQrRegion, sampleRefinedQrMatrix } from "./pageAlignedRecovery.js";
import { readErasedQrMatrix } from "./qrErasureRecovery.js";
import { bytePayloadFromCodewords, qredPayloadFromScanResult } from "./qrPayload.js";

const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";

// Isolate optical sampling after public-pattern alignment. The renderer
// knows the signed modules; the sampler receives only pixels and a grid.
function printedText(symbol) {
  const cellWidth = 12, cellHeight = 16, margin = 48;
  const width = symbol.modules.size * cellWidth + 2 * margin;
  const height = symbol.modules.size * cellHeight + 2 * margin;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const col = Math.floor((x - margin) / cellWidth), row = Math.floor((y - margin) / cellHeight);
    const inGrid = col >= 0 && row >= 0 && col < symbol.modules.size && row < symbol.modules.size;
    const paper = 240 - 28 * y / height;
    let value = paper * (inGrid && symbol.modules.get(row, col) ? 0.85 : 1);
    if (x > 90 && x < width - 90 && y > 120 && y < height - 120 &&
        y % 80 < 9 && Math.floor(x / 35) % 4 !== 0) value = 25;
    const offset = (y * width + x) * 4;
    data[offset] = data[offset + 1] = data[offset + 2] = value;
    data[offset + 3] = 255;
  }
  return { image: { data, width, height },
    moduleMap: (col, row) => ({ x: margin + col * cellWidth, y: margin + row * cellHeight }) };
}

it("recovers the exact signed payload through letter strokes that corrupt mean sampling", async () => {
  const { seals } = await createQRedSeals({
    privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", publicKey,
    content: "Text foreground robust sampling and public QR alignment evidence. ".repeat(20),
    encodingStrategy: "plaintext", timestamp: "2026-10-31T12:00:00Z",
  });
  expect(seals).toHaveLength(1);
  const symbol = createQRedQrSymbol(seals[0]);
  const { image, moduleMap } = printedText(symbol);
  const recover = foregroundRobust => {
    const sampled = sampleRefinedQrMatrix(image, moduleMap, symbol.version, { foregroundRobust });
    const recovered = readErasedQrMatrix(sampled.bits, sampled.unknown, symbol.version, sampled.confidence);
    return recovered && qredPayloadFromScanResult({ data: "", version: symbol.version,
      binaryData: bytePayloadFromCodewords(recovered.dataCodewords, symbol.version) });
  };
  expect(recover(false)).not.toBe(seals[0]);
  const recovered = recover(true);
  expect(recovered).toBe(seals[0]);
  await expect(verifyQRedSeals([recovered], publicKey)).resolves.toMatchObject({ status: "VALID" });

  // The real alignment/retry path must also recover it, not only sampling
  // against the renderer's exact module centers.
  const mapping = (u, v) => moduleMap(u * symbol.modules.size, v * symbol.modules.size);
  const aligned = recoverRefinedQrRegion(image, mapping, { x: 0, y: 0, width: 1, height: 1 }, symbol.version);
  expect(aligned?.seal).toBe(seals[0]);

  // With every pixel obscured there is no QR evidence to reconstruct.
  image.data.fill(25);
  expect(recover(true)).toBeFalsy();
}, 30000);
