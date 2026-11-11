import { afterEach, expect, it, vi } from "vitest";
import { decodePhoto } from "./decodePhoto.js";
import { createRectifiedSealScanner } from "./rectifiedSealScan.js";
import { createQRedSeals } from "../qredSealer.js";
import { verifyQRedSeals } from "../qredVerifier.js";

vi.mock("./scanQrImage.js", async importOriginal => ({
  ...await importOriginal(), scanWatermarkPreview: vi.fn(() => null),
}));
vi.mock("./rectifiedSealScan.js", () => ({ createRectifiedSealScanner: vi.fn(), prepareCurvedPageScan: vi.fn(() => ({ preferred: false, scan: () => null })) }));
vi.mock("./footerSealScan.js", () => ({ scanFooterSeals: vi.fn(() => []) }));
vi.mock("./pageAlignedScan.js", () => ({ scanPageAlignedImage: vi.fn(() => []) }));
afterEach(() => vi.restoreAllMocks());

it("lets later recovery run after real jsQR cancels inside a 12 MP photo's ordinary preflight", async () => {
  const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";
  const { seals } = await createQRedSeals({
    privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes", publicKey,
    content: "Synthetic scheduling regression, not optical recovery evidence.",
    timestamp: "2026-11-05T12:00:00Z",
  });
  const scan = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce({ seal: seals[0] });
  createRectifiedSealScanner.mockReturnValue(scan);
  // A deterministic scheduling clock, explicitly not a device-speed model.
  // The real jsQR hook must consult it while working; a between-call check
  // alone would leave this counter near zero and fail the regression.
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now++);
  const image = { width: 3000, height: 4000,
    data: new Uint8ClampedArray(3000 * 4000 * 4).fill(255) };
  const stages = [];
  // Use a two-second ordinary preflight to exercise cancellation inside jsQR.
  const result = decodePhoto(image, { returnPayload: true, maxDurationMs: 8000,
    onStage: stage => stages.push(stage.stage) });
  expect(now).toBeGreaterThanOrEqual(2000);
  expect(now).toBeLessThan(2100);
  expect(stages).toEqual(["rectified-fast", "watermark-preview", "ordinary-qr", "footer", "curved-page", "rectified-wide"]);
  expect(scan).toHaveBeenCalledTimes(2);
  expect(result).toEqual({ status: "found", text: seals[0] });
  vi.restoreAllMocks();
  await expect(verifyQRedSeals([result.text], publicKey)).resolves.toMatchObject({ status: "VALID" });
});
