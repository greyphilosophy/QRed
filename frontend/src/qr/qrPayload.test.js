import { describe, expect, it } from "vitest";
import ECLevel from "qrcode/lib/core/error-correction-level.js";
import Utils from "qrcode/lib/core/utils.js";
import ECCode from "qrcode/lib/core/error-correction-code.js";
import { createQRedQrData, qredPayloadCapacity } from "../qredQr.js";
import { encodeChunk, qrPayloadBytes, sealString } from "../sealFormat.js";
import { bytePayloadFromCodewords, extractQrBytePayload, qredPayloadFromScanResult } from "./qrPayload.js";

describe("standard QR byte payloads", () => {
  const seal = sealString(encodeChunk(new Uint8Array(32).fill(23), 0, 2,
    Uint8Array.from([0, 255, 128, 192, 254, 10])));

  it("uses the decoder's ordinary message bytes even when they are not UTF-8", () => {
    const binaryData = Array.from(qrPayloadBytes(seal));
    expect(qredPayloadFromScanResult({ data: "", binaryData })).toBe(seal);
    expect(qredPayloadFromScanResult({ data: seal })).toBe(seal);
    expect(qredPayloadFromScanResult({ data: "QRED.ORG" })).toBeNull();
    expect(qredPayloadFromScanResult({ data: "QRED4:invalid" })).toBeNull();
  });

  it("reads only the declared message and ignores bytes beyond its terminator", () => {
    const qr = createQRedQrData("Hi");
    const altered = qr.bytes.slice();
    altered.set([0xde, 0xad, 0xbe, 0xef], 4);
    expect(extractQrBytePayload(altered, qr.version)).toBe("Hi");
    expect(bytePayloadFromCodewords(Uint8Array.from([0, 0x40, 0x10, 0x41]), 1)).toBeNull();
    // The retired alphanumeric marker + terminator + private length format.
    const legacy = Uint8Array.from([0x20, 0x3d, 0x44, 0x44, 0xad, 0x4f, 0x50, 0x40,
      0, qrPayloadBytes(seal).length, ...qrPayloadBytes(seal)]);
    expect(extractQrBytePayload(legacy, 1)).toBeNull();
    expect(qredPayloadFromScanResult({ data: "QRED.ORG", correctedData: legacy })).toBeNull();
    expect(qredPayloadFromScanResult({ data: "QRED.ORG", binaryData: legacy })).toBeNull();
  });

  it("rejects truncated headers and lengths instead of reading beyond corrected data", () => {
    for (const version of [1, 9, 10, 40]) {
      expect(bytePayloadFromCodewords(Uint8Array.from([0x40]), version)).toBeNull();
      expect(bytePayloadFromCodewords(Uint8Array.from([0x4f, 0xff, 0xff]), version)).toBeNull();
    }
    for (const version of [0, 41, 1.5, undefined]) {
      expect(bytePayloadFromCodewords(new Uint8Array(4), version)).toBeNull();
    }
  });

  it("fits a byte header and whole payload at every QR capacity boundary", () => {
    for (let version = 1; version <= 40; version++) for (const level of [ECLevel.L, ECLevel.M, ECLevel.Q, ECLevel.H]) {
      const capacity = qredPayloadCapacity(version, level);
      const available = (Utils.getSymbolTotalCodewords(version) - ECCode.getTotalCodewordsCount(version, level)) * 8;
      const header = version < 10 ? 12 : 20;
      expect(header + capacity * 8).toBeLessThanOrEqual(available);
      expect(header + (capacity + 1) * 8).toBeGreaterThan(available);
    }
    expect(["L", "M", "Q", "H"].map(level => qredPayloadCapacity(40, ECLevel[level])))
      .toEqual([2953, 2331, 1663, 1273]);
  });
});
