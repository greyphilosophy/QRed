import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import QRCode from "qrcode";
import Alignment from "qrcode/lib/core/alignment-pattern";
import ECCode from "qrcode/lib/core/error-correction-code";
import ECLevel from "qrcode/lib/core/error-correction-level";
import FormatInfo from "qrcode/lib/core/format-info";
import Utils from "qrcode/lib/core/utils";
import Version from "qrcode/lib/core/version";
import { describe, expect, it } from "vitest";
import {
  alignmentCenters, decodeFormatInfo, EC_BLOCKS_BY_LEVEL, EC_CODEWORDS_BY_LEVEL,
  formatBitPositions, functionMask, QR_MODULE_COUNT_BY_VERSION, readFormatBits, TOTAL_CODEWORDS,
} from "./qrLowLevel.js";

// jsQR does not export its tables. Read the installed, patched bundle so a lost
// patch or dependency update cannot silently reintroduce a disagreement.
const require = createRequire(import.meta.url);
const decoderSource = readFileSync(require.resolve("jsqr"), "utf8");
function decoderTable(name) {
  const match = decoderSource.match(new RegExp(`${name} = (\\[[\\s\\S]*?\\n\\]);`));
  if (!match) throw new Error(`Cannot find jsQR table ${name}`);
  return JSON.parse(JSON.stringify(runInNewContext(`(${match[1]})`)));
}
const decoderVersions = decoderTable("exports\\.VERSIONS");
const decoderFormats = decoderTable("FORMAT_INFO_TABLE");
const versions = Array.from({ length: 40 }, (_, index) => index + 1);
const levels = [ECLevel.L, ECLevel.M, ECLevel.Q, ECLevel.H];

// These tables were also checked against ZXing's Version.java and Nayuki's
// qrcodegen.py. This suite keeps our three consumers in agreement afterward.
describe("QR tables across all supported versions", () => {
  it("has exactly the 40 standard QR versions", () => {
    expect(decoderVersions).toHaveLength(40);
    expect(QR_MODULE_COUNT_BY_VERSION).toHaveLength(41); // Index zero is unused.
    expect(QR_MODULE_COUNT_BY_VERSION[1]).toBe(21);
    expect(QR_MODULE_COUNT_BY_VERSION[40]).toBe(177);
    expect(QR_MODULE_COUNT_BY_VERSION[41]).toBeUndefined();
    expect(TOTAL_CODEWORDS).toHaveLength(41);
    for (const table of [...EC_BLOCKS_BY_LEVEL, ...EC_CODEWORDS_BY_LEVEL]) expect(table).toHaveLength(41);
  });

  it.each(versions)("agrees on layout and all correction levels for version %i", version => {
    const decoder = decoderVersions[version - 1];
    const size = Utils.getSymbolSize(version);
    const total = Utils.getSymbolTotalCodewords(version);
    expect(decoder.versionNumber).toBe(version);
    expect(QR_MODULE_COUNT_BY_VERSION[version]).toBe(size);
    expect(TOTAL_CODEWORDS[version]).toBe(total);
    expect(alignmentCenters(version)).toEqual(Alignment.getRowColCoords(version));
    expect(decoder.alignmentPatternCenters).toEqual(alignmentCenters(version));
    expect(decoder.infoBits).toBe(version < 7 ? null : Version.getEncodedBits(version));
    const dataModules = functionMask(size, version).flat().filter(reserved => !reserved).length;
    expect(Math.floor(dataModules / 8)).toBe(total);

    for (const [index, level] of levels.entries()) {
      const blocks = ECCode.getBlocksCount(version, level);
      const parity = ECCode.getTotalCodewordsCount(version, level);
      expect(EC_BLOCKS_BY_LEVEL[level.bit][version]).toBe(blocks);
      expect(EC_CODEWORDS_BY_LEVEL[level.bit][version]).toBe(parity);
      const correction = decoder.errorCorrectionLevels[index];
      expect(correction.ecCodewordsPerBlock * blocks).toBe(parity);
      const blockSizes = correction.ecBlocks.flatMap(group => Array(group.numBlocks).fill(group.dataCodewordsPerBlock));
      const shortBlocks = blocks - total % blocks;
      const shortSize = Math.floor((total - parity) / blocks);
      expect(blockSizes).toEqual(Array.from({ length: blocks }, (_, block) => shortSize + (block >= shortBlocks ? 1 : 0)));
    }
  });

  it("recovers all 32 format entries from either copy of an encoded symbol", () => {
    expect(decoderFormats).toHaveLength(32);
    for (const [index, level] of levels.entries()) {
      for (let mask = 0; mask < 8; mask += 1) {
        const bits = FormatInfo.getEncodedBits(level, mask);
        const format = decoderFormats.find(entry => entry.formatInfo.errorCorrectionLevel === index && entry.formatInfo.dataMask === mask);
        expect(format?.bits).toBe(bits);
        const qr = QRCode.create("QRED.ORG", { version: 2, errorCorrectionLevel: level, maskPattern: mask });
        const matrix = Array.from({ length: qr.modules.size }, (_, row) =>
          Array.from({ length: qr.modules.size }, (_, col) => Boolean(qr.modules.get(row, col))));
        expect(readFormatBits(matrix)).toEqual([bits, bits]);
        for (const positions of formatBitPositions(matrix.length)) {
          const damaged = matrix.map(row => [...row]);
          for (const [row, col] of positions) damaged[row][col] = false;
          expect(decodeFormatInfo(damaged)).toEqual({ ecLevelBits: level.bit, maskPattern: mask });
        }
      }
    }
  });
});
