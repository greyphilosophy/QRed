import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createQRedSeals } from "../qredSealer.js";
import { createQRedQrData } from "../qredQr.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { decodePhoto } from "./decodePhoto.js";
import { scanQrImage, scanWatermarkPreview } from "./scanQrImage.js";
import { scanPageAlignedImage } from "./pageAlignedScan.js";

vi.mock("./scanQrImage.js", () => ({ scanQrImage: vi.fn(), scanWatermarkPreview: vi.fn() }));
vi.mock("./pageAlignedScan.js", () => ({ scanPageAlignedImage: vi.fn() }));

const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";
const image = { width: 320, height: 240, data: new Uint8ClampedArray(320 * 240 * 4) };
let single, multiple;
function code(seal) {
  const { payloadBytes, version } = createQRedQrData(seal);
  return { data: "", binaryData: Array.from(payloadBytes), version };
}
beforeAll(async () => {
  const options = { privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", publicKey,
    timestamp: "2026-11-01T12:00:00Z", pageContext: { pageNumber: 1, pageCount: 1 } };
  single = (await createQRedSeals({ ...options, content: "Fast photo recovery" })).seals[0];
  multiple = (await createQRedSeals({ ...options, content: "Four printed watermark chunks. ".repeat(160),
    encodingStrategy: "plaintext", preferFourQrPage: true })).seals;
  expect(multiple).toHaveLength(4);
});
beforeEach(() => {
  scanWatermarkPreview.mockReset().mockReturnValue(null);
  scanPageAlignedImage.mockReset().mockReturnValue([]);
  scanQrImage.mockReset().mockReturnValue(null);
});

it("returns a complete preview seal without alignment and still requires signature verification", async () => {
  scanWatermarkPreview.mockReturnValue(code(single));
  const action = decodePhoto(image, { returnPayload: true });
  expect(action).toEqual({ status: "found", text: single });
  expect(scanPageAlignedImage).not.toHaveBeenCalled();
  expect(scanQrImage).not.toHaveBeenCalled();
  expect((await verifyQRedSeals([action.text], publicKey)).status).toBe("VALID");
  expect((await verifyQRedSeals([action.text], "Eia2iJ9vDsWocr42GjIagNI0cOVVjy8F2l-6_QgMCdI")).status).toBe("INVALID");
});

it.each(["HTTPS://QRED.ORG", "https://example.test"])("continues watermark recovery after a preview reads %s", data => {
  scanWatermarkPreview.mockReturnValue({ data });
  scanPageAlignedImage.mockReturnValue([{ seal: single }]);
  expect(decodePhoto(image, { returnPayload: true })).toEqual({ status: "found-multiple", texts: [single] });
  expect(scanPageAlignedImage).toHaveBeenCalledWith(image, { deep: true });
});

it("collects all four chunks even when the preview has already read one", () => {
  scanWatermarkPreview.mockReturnValue(code(multiple[2]));
  scanPageAlignedImage.mockReturnValue(multiple.map(seal => ({ seal })));
  expect(decodePhoto(image, { returnPayload: true })).toEqual({ status: "found-multiple", texts: multiple });
});

it("keeps original-resolution alignment and legacy recovery after a preview miss", () => {
  scanQrImage.mockReturnValueOnce(null).mockReturnValue(code(single));
  expect(decodePhoto(image, { returnPayload: true })).toEqual({ status: "found", text: single });
  expect(scanPageAlignedImage.mock.calls[0][0]).toBe(image);
  expect(scanQrImage).toHaveBeenCalledWith(image.data, image.width, image.height);
});

it("recovers a complete ordinary footer seal before exhaustive alignment", async () => {
  scanQrImage.mockReturnValue(code(single));
  const action = decodePhoto(image, { returnPayload: true });
  expect(action).toEqual({ status: "found", text: single });
  expect(scanPageAlignedImage).not.toHaveBeenCalled();
  expect(scanQrImage).toHaveBeenCalledTimes(1);
  expect(scanQrImage).toHaveBeenCalledWith(image.data, image.width, image.height,
    { tryRescaling: false, tryWatermark: false, maxAttempts: 2 });
  expect((await verifyQRedSeals([action.text], publicKey)).status).toBe("VALID");
});

it("does not let a single footer chunk skip collection of the remaining chunks", () => {
  scanQrImage.mockReturnValue(code(multiple[0]));
  scanPageAlignedImage.mockReturnValue(multiple.map(seal => ({ seal })));
  expect(decodePhoto(image, { returnPayload: true })).toEqual({ status: "found-multiple", texts: multiple });
});
