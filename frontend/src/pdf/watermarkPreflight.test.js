import { beforeEach, describe, expect, it, vi } from "vitest";
import { scanQrImage } from "../qr/scanQrImage.js";
import { simulatePrintPhoto, scanAllSealsFromPage } from "./watermarkPreflight.js";

vi.mock("../qr/scanQrImage.js", () => ({ scanQrImage: vi.fn() }));
vi.mock("../qr/hiddenPayload.js", () => ({ hiddenPayloadFromScanResult: result => result?.payload ?? null }));

const position = { topLeftCorner: { x: 3, y: 3 }, topRightCorner: { x: 10, y: 3 },
  bottomRightCorner: { x: 10, y: 10 }, bottomLeftCorner: { x: 3, y: 10 } };
const photo = () => ({ width: 20, height: 20, data: new Uint8ClampedArray(20 * 20 * 4).fill(255) });

beforeEach(() => vi.resetAllMocks());

describe("watermark sealing preflight", () => {
  it("requires discovery and the exact payload, not just a visible QR string", () => {
    scanQrImage.mockReturnValue({ data: "QRED.ORG", location: position });
    expect(scanAllSealsFromPage(photo(), ["signed-seal"])).toBe(false);
    scanQrImage.mockReturnValue({ data: "QRED.ORG", payload: "signed-seal", location: position });
    expect(scanAllSealsFromPage(photo(), ["signed-seal"])).toBe(true);
  });

  it("requires every part of a multi-code page without using layout hints", () => {
    scanQrImage.mockReturnValueOnce({ payload: "part-a", location: position })
      .mockReturnValueOnce({ payload: "part-b", location: position });
    expect(scanAllSealsFromPage(photo(), ["part-a", "part-b"])).toBe(true);
    expect(scanQrImage).toHaveBeenCalledTimes(2);
  });

  it("fails closed when later codes are not independently discoverable", () => {
    scanQrImage.mockReturnValueOnce({ payload: "part-a", location: position }).mockReturnValue(null);
    expect(scanAllSealsFromPage(photo(), ["part-a", "part-b"])).toBe(false);
  });

  it("adds modest photo shading and softening without modifying the clean render", () => {
    const image = photo();
    image.data.fill(255);
    image.data[0] = image.data[1] = image.data[2] = 215;
    const result = simulatePrintPhoto(image);
    expect(result.data).not.toBe(image.data);
    expect(result.data[0]).toBeGreaterThan(215);
    expect(result.data[(19 * 20 + 19) * 4]).toBeLessThan(255);
    expect(image.data[0]).toBe(215);
    expect(result.data[3]).toBe(255);
  });
});
