import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { verifyQRedSeals } from "../qredVerifier.js";
import { simulatePrintPhoto } from "../pdf/watermarkPreflight.js";
import { renderSealedPdf } from "../pdf/renderSealedPdf.js";
import { scanPageAlignedImage } from "./pageAlignedScan.js";
import { decodePhoto } from "./decodePhoto.js";
import { bannerFile, bannerReference, framedBanner, renderBanner } from "./testSupport/blackBannerFixture.js";

describe("solid banners with reversed text", () => {
  it.each(["control", "normal", "tall"])("recovers the exact signed %s page before and after print softening", async kind => {
    const image = await renderBanner(kind), original = Buffer.from(image.data);
    for (const softened of [false, true]) {
      const input = softened ? { ...image, ...simulatePrintPhoto(image) } : image;
      const results = scanPageAlignedImage(input);
      expect(results.map(result => result.seal), `${kind}, softened=${softened}`).toEqual(bannerReference.seals);
      await expect(verifyQRedSeals(results.map(result => result.seal), bannerReference.publicKey))
        .resolves.toMatchObject({ status: "VALID", signature_valid: true });
    }
    expect(Buffer.from(image.data).equals(original)).toBe(true);
  }, 20000);

  it.each(["normal", "tall"])("keeps the %s watermark through production preflight and navigation placement", async kind => {
    const result = await renderSealedPdf({ file: bannerFile(kind), pageSealResults: [bannerReference],
      pagesWithText: [true], pageScalingStrategy: "watermark-sheets" });
    expect(result.watermarkLayout[0]).toMatchObject({ pageAligned: true });
    expect(result.sheetCount).toBe(0);
    expect(result.pageSealStrings).toEqual([bannerReference.seals]);
  }, 20000);

  it.each(["normal", "tall"])("recovers a framed %s page through the actual still-photo entry point", async kind => {
    const image = framedBanner(await renderBanner(kind)), original = Buffer.from(image.data);
    // Use the production scan budget; concurrent CI workers are not a phone
    // speed benchmark. Keep stage evidence if recovery exhausts that budget.
    const stages = [];
    const result = decodePhoto(image, { returnPayload: true, onStage: stage => stages.push(stage) });
    const seals = result.texts ?? (result.text ? [result.text] : []);
    expect(seals.length, JSON.stringify({ status: result.status, stages })).toBe(bannerReference.seals.length);
    expect(seals).toEqual(bannerReference.seals);
    await expect(verifyQRedSeals(seals, bannerReference.publicKey)).resolves.toMatchObject({ status: "VALID" });
    expect(Buffer.from(image.data).equals(original)).toBe(true);
  }, 70000);

  it("does not manufacture a seal when the watermark is completely covered", async () => {
    const image = await renderBanner("normal");
    for (let y = 108; y < 1476; y++) for (let x = 108; x < 1116; x++) {
      const i = (y * image.width + x) * 4;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = 0;
    }
    expect(scanPageAlignedImage(image)).toEqual([]);
    expect(scanPageAlignedImage(image, { shouldContinue: () => false })).toEqual([]);
  });
});
