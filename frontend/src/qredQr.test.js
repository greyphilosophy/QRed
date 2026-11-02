import ECLevel from "qrcode/lib/core/error-correction-level";
import { describe, expect, it } from "vitest";
import { createQRedQrData } from "./qredQr.js";
import { extractQrBytePayload } from "./qr/qrPayload.js";

describe("automatic QR grid sizing", () => {
  it.each([
    // Ordinary byte-mode capacity, choosing the strongest level in the smallest grid.
    [3, 1, "H"], [7, 1, "H"], [8, 1, "Q"], [11, 1, "Q"],
    [12, 1, "M"], [14, 1, "M"], [15, 1, "L"], [17, 1, "L"],
    [18, 2, "Q"], [1367, 26, "L"], [1368, 27, "L"], [2953, 40, "L"],
  ])("fits %i bytes into version %i with correction %s", (length, version, level) => {
    const payload = "x".repeat(length);
    const qr = createQRedQrData(payload);
    expect(qr.version).toBe(version);
    expect(qr.errorCorrectionLevel).toEqual(ECLevel[level]);
    expect(extractQrBytePayload(qr.bytes, qr.version)).toBe(payload);
  });

  it("counts UTF-8 bytes rather than characters", () => {
    const qr = createQRedQrData("😀😀😀");
    expect(qr.version).toBe(1);
    expect(qr.errorCorrectionLevel).toEqual(ECLevel.M);
    expect(extractQrBytePayload(qr.bytes, qr.version)).toBe("😀😀😀");
  });

  it("rejects data beyond capacity without downgrading an explicit correction level", () => {
    expect(() => createQRedQrData("x".repeat(2954))).toThrow(/too big/);
    expect(() => createQRedQrData("x".repeat(1274), { errorCorrectionLevel: "H" })).toThrow(/too big/);
  });
});
