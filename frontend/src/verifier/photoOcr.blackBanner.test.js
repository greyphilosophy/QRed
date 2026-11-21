import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { createWorker } from "tesseract.js";
import { expect, it, vi } from "vitest";
import { verifyQRedSeals } from "../qredVerifier.js";
import { bannerReference, framedBanner, renderBanner } from "../qr/testSupport/blackBannerFixture.js";
import { createPhotoOcrReader } from "./photoOcr.js";
import { preparePhotoReadingPixels } from "./photoReadingPixels.js";
import { comparePageReading } from "./photoReading.js";

// Adapt native canvas/worker transport only. Recognition, image preparation,
// localized retries and comparison are all the production implementations.
it.each(["normal", "tall"])("reads the %s white banner and flags changed status text and digits with real offline OCR", async kind => {
  const model = dirname(createRequire(import.meta.url).resolve("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"));
  vi.stubGlobal("document", { createElement: () => createCanvas(1, 1) });
  vi.stubGlobal("ImageData", ImageData);
  const reader = createPhotoOcrReader(async (_language, _mode, options) => {
    const worker = await createWorker("eng", 1, { langPath: model, cacheMethod: "none", logger: options.logger });
    const recognize = worker.recognize;
    worker.recognize = (input, options, output) => {
      expect(options).toEqual({}); // No signed wording or OCR character hints.
      return recognize(input.toBuffer("image/png"), options, output);
    };
    return worker;
  }, async canvas => {
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    const { image, codes, corners } = preparePhotoReadingPixels(pixels);
    const copy = createCanvas(image.width, image.height);
    copy.getContext("2d").putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    return { canvas: copy, codes, corners };
  });
  try {
    const verified = await verifyQRedSeals(bannerReference.seals, bannerReference.publicKey);
    expect(verified.status).toBe("VALID");
    const source = framedBanner(await renderBanner(kind));
    for (const changed of [false, true]) {
      const canvas = createCanvas(source.width, source.height), context = canvas.getContext("2d");
      context.putImageData(new ImageData(source.data.slice(), source.width, source.height), 0, 0);
      if (changed) {
        // Edit the photographed content while retaining the original seal.
        context.fillStyle = "black"; context.fillRect(144, 744, 1056, 44);
        context.font = "bold 24px Arial"; context.fillStyle = "white"; context.textAlign = "center";
        context.fillText("Orientation Incomplete", source.width / 2, 774);
        context.fillStyle = "white"; context.fillRect(482, 438, 190, 26);
        context.font = "bold 21px Arial"; context.fillStyle = "black"; context.textAlign = "left";
        context.fillText("DEMO-2032-46", 484, 460);
      }
      const before = Buffer.from(context.getImageData(0, 0, canvas.width, canvas.height).data);
      const reading = await reader.read(canvas, () => {}, { text: verified.content,
        evidence: verified.evidence, pageNumber: 1 });
      const comparison = comparePageReading(verified.content, reading, canvas, verified.evidence, { pageNumber: 1 });
      const banner = reading.words.filter(word => word.bbox.y0 < 800 && word.bbox.y1 > 740).map(word => word.text).join(" ");
      expect(banner).toMatch(changed ? /\bOrientation Incomplete\b/ : /\bOrientation Complete\b/);
      if (changed) {
        expect(comparison.differences.some(d => /Complete/.test(d.expected) && /Incomplete/.test(d.observed))).toBe(true);
        expect(comparison.differences.some(d => /2037/.test(d.expected) && /2032/.test(d.observed))).toBe(true);
      } else {
        expect(comparison.differences.filter(d => /Orientation|Complete/.test(d.expected + " " + d.observed))).toEqual([]);
      }
      expect(Buffer.from(context.getImageData(0, 0, canvas.width, canvas.height).data).equals(before)).toBe(true);
    }
  } finally { reader.dispose(); vi.unstubAllGlobals(); }
}, 30000);
