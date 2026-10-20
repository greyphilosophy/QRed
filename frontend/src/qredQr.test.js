import ECLevel from "qrcode/lib/core/error-correction-level";
import { describe, expect, it } from "vitest";
import { createQRedQrData } from "./qredQr.js";
import { extractHiddenQRedPayload } from "./qr/hiddenPayload.js";

describe("automatic QR grid sizing", () => {
  it.each([
    // These payload limits include QRED.ORG, the terminator and length field.
    [3, 1, "Q"], [4, 1, "M"], [6, 1, "M"], [7, 1, "L"], [9, 1, "L"],
    [10, 2, "Q"], [18, 2, "M"], [19, 2, "L"],
    // The visible character-count field grows at version 27.
    [1360, 26, "L"], [1361, 27, "L"], [2945, 40, "L"],
  ])("fits %i bytes into version %i with correction %s", (length, version, level) => {
    const payload = "x".repeat(length);
    const qr = createQRedQrData(payload);
    expect(qr.version).toBe(version);
    expect(qr.errorCorrectionLevel).toEqual(ECLevel[level]);
    expect(extractHiddenQRedPayload(qr.bytes, qr.version)).toBe(payload);
  });

  it("counts UTF-8 bytes rather than characters", () => {
    const qr = createQRedQrData("😀😀😀");
    expect(qr.version).toBe(2);
    expect(qr.errorCorrectionLevel).toEqual(ECLevel.Q);
    expect(extractHiddenQRedPayload(qr.bytes, qr.version)).toBe("😀😀😀");
  });

  it("rejects data beyond capacity without downgrading an explicit correction level", () => {
    expect(() => createQRedQrData("x".repeat(2946))).toThrow(/too big/);
    expect(() => createQRedQrData("x".repeat(1266), { errorCorrectionLevel: "H" })).toThrow(/too big/);
  });
});
