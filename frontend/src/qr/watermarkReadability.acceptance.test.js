// Acceptance gates for docs/WATERMARK_READABILITY_REQUIREMENTS.md.
// These exercise production placement, PDF drawing, image scanning and
// cryptographic verification. They are deliberately red until page-coordinate
// geometry and rectangular watermark recovery are actually implemented.
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { createQRedSeals } from "../qredSealer.js";
import { createQRedQrSymbol } from "../qredQr.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { planWatermarks } from "../pdf/watermarkPlacement.js";
import { stampWatermarks } from "../pdf/watermark.js";
import { renderPdfPage, withPdfDocument } from "../pdf/readPdfText.js";
import { scanPdfPage } from "../verifier/scanPdf.js";
import { MIN_WATERMARK_MARGIN_POINTS, pageWatermarkRegions, scanPageAlignedImage } from "./pageAlignedScan.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";
const pageSize = { width: 612, height: 792 };
const margin = MIN_WATERMARK_MARGIN_POINTS;

function blankPage() {
  const width = pageSize.width, height = pageSize.height;
  return {
    data: new Uint8ClampedArray(width * height * 4).fill(255),
    width, height, scale: 1,
    bounds: { x: 0, y: 0, width, height },
  };
}

function outputColor(data, offset, rgb) {
  data[offset] = rgb[0]; data[offset + 1] = rgb[1];
  data[offset + 2] = rgb[2]; data[offset + 3] = 255;
}

async function signed(content) {
  return createQRedSeals({
    privateKey, publicKey, content, encodingStrategy: "plaintext",
    timestamp: "2026-10-31T12:00:00Z",
    pageContext: { pageNumber: 1, pageCount: 1 },
  });
}

// This produces a real projective warp, not merely an axis-aligned resized QR.
// A printed rectangular sheet is photographed against a charcoal desk.
// Sheet coordinates and QR chunk boundaries are known only to this test
// renderer; the production scanner receives pixels, dimensions and NO hints.
function printAndPhotograph(seals, {
  width = 690, height = 900, ink = [65, 120, 235],
  tilted = true, finderBlocked = true, text = true,
  backdrop = [43, 43, 47], patternedBackdrop = false, shadowed = false,
  printGray = 0.85, paperBase = 246, printerScale = 1,
  pageFormat = pageSize, legacyMargins = false, printerWarp = 0,
} = {}) {
  const symbols = seals.map(seal => createQRedQrSymbol(seal));
  if (![0, 1, 4].includes(symbols.length)) throw new Error("Fixture supports 0, 1 or 4 QR chunks");
  const boxes = symbols.length
    ? pageWatermarkRegions(symbols.length, pageFormat, { legacy: legacyMargins })
      .map(region => ({ x: region.x, y: region.y, w: region.width, h: region.height }))
    : [];
  // Projective mapping: x=(a+b*u+c*v)/(1+k*u+l*v),
  //                     y=(d+e*u+f*v)/(1+k*u+l*v).
  const a = 26, b = width - 65, c = tilted ? 11 : 0;
  const d = 21, e = tilted ? 14 : 0, f = height - 59;
  const k = tilted ? 0.08 : 0, l = tilted ? 0.035 : 0;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    const offset = (py * width + px) * 4;
    const A = b - k * px, B = c - l * px;
    const C = e - k * py, D = f - l * py;
    const det = A * D - B * C;
    const rhsX = px - a, rhsY = py - d;
    const u = (rhsX * D - B * rhsY) / det;
    const v = (A * rhsY - rhsX * C) / det;
    if (u < 0 || v < 0 || u >= 1 || v >= 1) {
      const motif = (Math.floor(px / 29) * 5 + Math.floor(py / 37) * 7) % 9;
      outputColor(rgba, offset, patternedBackdrop
        ? (motif < 3 ? [160, 100, 180] : [48, 28, 76]) : backdrop);
      continue;
    }
    // Apply uneven lighting and slight deterministic photo noise.
    const paper = (shadowed ? 137 + 108 * u : paperBase) - 10 * v - 3 * u +
      ((px * 7 + py * 13) % 5 - 2);
    let value = paper;
    // Physical printer content is not guaranteed to occupy the same region
    // of the paper as the source PDF. Keep the paper corners unchanged while
    // independently shrinking the printed content.
    const baseU = 0.5 + (u - 0.5) / printerScale;
    const baseV = 0.5 + (v - 0.5) / printerScale;
    // Printer/camera distortion that differs across a single sheet, rather
    // than a uniform 97% shrink. This must be calibrated from visible QR
    // alignment patterns, not from a saved PDF or a global page homography.
    const sheetU = baseU + printerWarp * (baseV - 0.5) * (baseU - 0.5);
    const sheetV = baseV + printerWarp * (baseU - 0.5) ** 2;
    let localRow = -1, localCol = -1, matchedPart = -1;
    for (let part = 0; part < symbols.length; part++) {
      const box = boxes[part];
      if (sheetU < box.x || sheetU >= box.x + box.w ||
          sheetV < box.y || sheetV >= box.y + box.h) continue;
      const size = symbols[part].modules.size;
      localCol = Math.floor((sheetU - box.x) / box.w * size);
      localRow = Math.floor((sheetV - box.y) / box.h * size);
      value = paper * (symbols[part].modules.get(localRow, localCol) ? printGray : 1);
      matchedPart = part;
      break;
    }
    let pixel = [value, value, value];
    // Horizontal colored or black letter strokes cross modules but leave
    // exposed pixels elsewhere. Color is deliberately unrelated to QR bits.
    if (text && sheetU > 0.09 && sheetU < 0.91 && sheetV > 0.14 && sheetV < 0.86 &&
        (Math.floor(v * 760) % 27 < 3) && Math.floor(u * 600 / 13) % 4 !== 0) {
      pixel = ink;
    }
    // Deliberately obscure one entire finder. Generic finder detection cannot
    // be the sole way to establish coordinates; paper geometry must assist.
    if (finderBlocked && matchedPart === 0 && localRow >= 0 && localRow < 9 &&
        localCol >= 0 && localCol < 9) pixel = ink;
    outputColor(rgba, offset, pixel);
  }
  return { data: rgba, width, height };
}

// Simulate a high-megapixel phone capture without changing the photographed
// content. The verifier must read ORIGINAL pixels; only page-edge detection
// is allowed to run on a bounded analysis preview.
function enlargedPhoto(source, factor = 5) {
  const width = source.width * factor, height = source.height * factor;
  const data = new Uint8ClampedArray(width * height * 4);
  const row = new Uint8ClampedArray(width * 4);
  for (let sy = 0; sy < source.height; sy++) {
    for (let sx = 0; sx < source.width; sx++) {
      const input = (sy * source.width + sx) * 4;
      for (let dx = 0; dx < factor; dx++) {
        row.set(source.data.subarray(input, input + 4), (sx * factor + dx) * 4);
      }
    }
    for (let dy = 0; dy < factor; dy++) {
      data.set(row, ((sy * factor + dy) * width) * 4);
    }
  }
  return { data, width, height };
}

function sampleAtPagePoint(image, x, y) {
  const { bounds, scale, width, data } = image;
  const sx = Math.floor((x - bounds.x) * scale);
  const sy = Math.floor((bounds.y + bounds.height - y) * scale);
  return data[(sy * width + sx) * 4];
}

describe("watermark readability acceptance contract (requirements WM-01..08)", () => {
  it("[WM-02] enlarges a single QR over >=80% of usable letter-paper area, with rectangular cells", () => {
    const [box] = planWatermarks(blankPage(), [{ modules: { size: 177 } }]);
    const usableWidth = pageSize.width - margin * 2;
    const usableHeight = pageSize.height - margin * 2;
    expect(box.width * box.height / (usableWidth * usableHeight)).toBeGreaterThanOrEqual(0.80);
    expect(box.height / box.width).toBeGreaterThanOrEqual(1.15);
    expect(box.x).toBeGreaterThanOrEqual(margin);
    expect(box.y).toBeGreaterThanOrEqual(margin);
    expect(box.x + box.width).toBeLessThanOrEqual(pageSize.width - margin + 0.001);
    expect(box.y + box.height).toBeLessThanOrEqual(pageSize.height - margin + 0.001);
  });

  it("[WM-12] provides at least 0.75-inch clearance for every QR region on different paper sizes", () => {
    const sizes = [
      { width: 612, height: 792 },       // US Letter
      { width: 595.28, height: 841.89 }, // A4
      { width: 612, height: 1008 },      // US Legal
      { width: 841.89, height: 1190.55 }, // A3
    ];
    for (const size of sizes) {
      for (const count of [1, 4]) {
        const regions = pageWatermarkRegions(count, size);
        expect(regions).toHaveLength(count);
        const boxes = regions.map(region => ({
          left: region.x * size.width, right: (1 - region.x - region.width) * size.width,
          top: region.y * size.height, bottom: (1 - region.y - region.height) * size.height,
        }));
        for (const box of boxes) {
          expect(box.left).toBeGreaterThanOrEqual(margin - 0.001);
          expect(box.right).toBeGreaterThanOrEqual(margin - 0.001);
          expect(box.top).toBeGreaterThanOrEqual(margin - 0.001);
          expect(box.bottom).toBeGreaterThanOrEqual(margin - 0.001);
        }
        const first = regions[0], last = regions.at(-1);
        expect(first.x * size.width).toBeCloseTo(54, 3);
        expect(first.y * size.height).toBeCloseTo(54, 3);
        expect((1 - last.x - last.width) * size.width).toBeCloseTo(54, 3);
        expect((1 - last.y - last.height) * size.height).toBeCloseTo(54, 3);
      }
    }
  });

  it("[WM-12] refuses four version-40 watermarks if 0.75-inch margins make modules too small", () => {
    const symbols = Array.from({ length: 4 }, () => ({ modules: { size: 177 } }));
    expect(() => planWatermarks(blankPage(), symbols))
      .toThrow(/too dense|footer layout/i);
  });

  it("[WM-02] actually PRINTS the stretched module grid at its rectangular coordinates", async () => {
    const payload = (await signed("Rectangular watermark renderer check.")).seals[0];
    const qr = createQRedQrSymbol(payload);
    const box = { x: 54, y: 54, width: 504, height: 684 };
    const pdf = await PDFDocument.create();
    pdf.addPage([pageSize.width, pageSize.height]);
    await stampWatermarks(pdf, [{ boxes: [box], pageAligned: true }], [{ seals: [payload] }]);
    const file = new Blob([await pdf.save()], { type: "application/pdf" });
    const image = await withPdfDocument(file, instance => renderPdfPage(instance, 1, 2));
    const n = qr.modules.size;
    // One of the dark pixels in the bottom-left and top-right finder cores.
    for (const [row, col] of [[n - 4, 3], [3, n - 4]]) {
      expect(qr.modules.get(row, col)).toBeTruthy();
      const x = box.x + (col + 0.5) * box.width / n;
      const y = box.y + box.height - (row + 0.5) * box.height / n;
      expect(sampleAtPagePoint(image, x, y), `finder module ${row},${col}`).toBeLessThan(239);
    }
  }, 30000);

  it("[WM-01, WM-03, WM-05] recovers signed bytes from a perspective sheet with one unreadable finder", async () => {
    const content = ("PAGE COORDINATE CHALLENGE\n" + "Inventory and inspection text. ".repeat(25)).trimEnd();
    const { seals } = await signed(content);
    expect(seals).toHaveLength(1);
    const photo = printAndPhotograph(seals, { ink: [223, 62, 67] });
    const { seals: recovered } = await scanPdfPage(photo);
    expect(recovered).toContain(seals[0]);
    await expect(verifyQRedSeals(recovered, publicKey)).resolves.toMatchObject({ status: "VALID", content });
  }, 120000);

  it.each([
    ["light neutral tabletop", [229, 229, 229]],
    ["light blue tabletop", [226, 235, 244]],
  ])("[WM-01, WM-03] reads a page photographed against a %s", async (_label, backdrop) => {
    const content = "Pale-watermark-on-light-desk. ".repeat(18).trimEnd();
    const { seals } = await signed(content);
    expect(seals).toHaveLength(1);
    const photo = printAndPhotograph(seals, { backdrop, ink: [52, 126, 220] });
    const { seals: recovered } = await scanPdfPage(photo);
    expect(recovered).toContain(seals[0]);
    await expect(verifyQRedSeals(recovered, publicKey))
      .resolves.toMatchObject({ status: "VALID", content });
  }, 45000);

  it("[WM-01] reads a >12MP photo without downsampling its QR module evidence", async () => {
    const content = "High resolution page coordinate challenge. ".repeat(16).trimEnd();
    const { seals } = await signed(content);
    expect(seals).toHaveLength(1);
    const image = enlargedPhoto(printAndPhotograph(seals, {
      backdrop: [222, 224, 226], ink: [217, 79, 90],
    }), 5);
    expect(image.width * image.height).toBeGreaterThan(12_000_000);
    const { seals: recovered } = await scanPdfPage(image);
    expect(recovered).toContain(seals[0]);
    await expect(verifyQRedSeals(recovered, publicKey))
      .resolves.toMatchObject({ status: "VALID", content });
  }, 90000);

  it("[WM-01, WM-03] recovers a signed rectangular watermark over patterned purple cloth and strong shadow", async () => {
    const content = "Strongly shaded physical-photo regression with purple patterned background. ".repeat(7).trim();
    const { seals } = await signed(content);
    expect(seals).toHaveLength(1);
    const photo = printAndPhotograph(seals, {
      width: 850, height: 1120, ink: [64, 118, 235],
      patternedBackdrop: true, shadowed: true,
    });
    const recovered = await scanPdfPage(photo);
    expect(recovered.seals).toContain(seals[0]);
    await expect(verifyQRedSeals(recovered.seals, publicKey))
      .resolves.toMatchObject({ status: "VALID", content });
  }, 60000);

  it("[WM-03] calibrates to pale printed ink on gray-exposed paper", async () => {
    const content = "Printed low-contrast paper and ink test. ".repeat(17).trimEnd();
    const { seals } = await signed(content);
    expect(seals).toHaveLength(1);
    const photo = printAndPhotograph(seals, {
      printGray: 0.925, paperBase: 208, ink: [210, 65, 80],
      finderBlocked: true,
    });
    const recovered = await scanPdfPage(photo);
    expect(recovered.seals).toContain(seals[0]);
    await expect(verifyQRedSeals(recovered.seals, publicKey))
      .resolves.toMatchObject({ status: "VALID", content });
  }, 30000);

  it.each([
    ["one QR", 1],
    ["four adjacent QRs", 4],
  ])("[WM-11] recalibrates PDF-to-paper print shrink for %s", async (_label, count) => {
    const content = count === 1
      ? "Printer alignment evidence. ".repeat(21).trimEnd()
      : "Four-quadrant printer-scale challenge. ".repeat(260).trimEnd();
    const { seals } = await signed(content);
    expect(seals).toHaveLength(count);
    const photo = printAndPhotograph(seals, {
      width: count === 1 ? 690 : 1000, height: count === 1 ? 900 : 1300,
      printerScale: 0.97, text: false, finderBlocked: false,
    });
    const recovered = scanPageAlignedImage(photo).map(result => result.seal);
    expect(new Set(recovered)).toEqual(new Set(seals));
    await expect(verifyQRedSeals(recovered, publicKey))
      .resolves.toMatchObject({ status: "VALID", content });
  }, 60000);

  it("[WM-11] recovers independently warped 2x2 modules using only photographed alignment patterns", async () => {
    const content = "Physical printer warp signed-page challenge. ".repeat(180).trimEnd();
    const { seals } = await signed(content);
    expect(seals).toHaveLength(4);
    const photo = printAndPhotograph(seals, {
      width: 1200, height: 1600, text: false, finderBlocked: false,
      printerScale: 0.97, printerWarp: 0.035,
    });
    const recovered = scanPageAlignedImage(photo, { deep: true });
    expect(new Set(recovered.map(item => item.seal))).toEqual(new Set(seals));
    expect(recovered.some(item => item.code.refined)).toBe(true);
    for (const item of recovered) {
      expect(item.code.version).toBeGreaterThanOrEqual(7);
      expect(item.code.pageAligned).toBe(true);
    }
    await expect(verifyQRedSeals(recovered.map(item => item.seal).toReversed(), publicKey))
      .resolves.toMatchObject({ status: "VALID", content });
  }, 90000);

  it("[WM-12] decodes a physically margin-safe A4 watermark from pixels alone", async () => {
    const content = "A4 paper; real 54pt (0.75in) QR clearance on all four sides. ".repeat(10).trimEnd();
    const { seals } = await signed(content);
    expect(seals).toHaveLength(1);
    const photo = printAndPhotograph(seals, {
      width: 720, height: 1050, pageFormat: { width: 595.28, height: 841.89 },
    });
    const found = scanPageAlignedImage(photo).map(item => item.seal);
    expect(found).toContain(seals[0]);
    await expect(verifyQRedSeals(found, publicKey))
      .resolves.toMatchObject({ status: "VALID", content });
  }, 60000);

  it("[WM-12] decodes legacy 3%-margin sealed pages after the margin change", async () => {
    const content = "Earlier rectangular QRed print with legacy three-percent inset. ".repeat(8).trimEnd();
    const { seals } = await signed(content);
    expect(seals).toHaveLength(1);
    const photo = printAndPhotograph(seals, {
      legacyMargins: true, finderBlocked: false, text: false,
    });
    expect(scanPageAlignedImage(photo).map(item => item.seal)).toContain(seals[0]);
  }, 60000);

  it("[WM-04, WM-05] reconstructs FOUR adjacent QR grids with no internal quiet zones", async () => {
    const content = "Four-quadrant signed page\n" + "QRed evidence-".repeat(700);
    const { seals } = await signed(content);
    expect(seals).toHaveLength(4);
    const photo = printAndPhotograph(seals, {
      width: 1000, height: 1300, ink: [61, 135, 225], tilted: true,
    });
    const { seals: recovered } = await scanPdfPage(photo);
    expect(new Set(recovered)).toEqual(new Set(seals));
    await expect(verifyQRedSeals(recovered.toReversed(), publicKey))
      .resolves.toMatchObject({ status: "VALID", content });
    await expect(verifyQRedSeals(seals.slice(1), publicKey))
      .resolves.toMatchObject({ status: "INCOMPLETE" });
  }, 120000);

  it("[WM-05] never reports a signed seal on blank paper with colored foreground alone", async () => {
    const photo = printAndPhotograph([], { ink: [216, 86, 72], finderBlocked: false });
    expect((await scanPdfPage(photo)).seals).toEqual([]);
  }, 30000);

  it("[WM-03, WM-08] achieves >=4/5 signed recoveries and >=3 wins over finder-only baseline", async () => {
    const content = "WM08 reproducible color benchmark\n" + "A123/2026 - inspected.".repeat(45);
    const { seals } = await signed(content);
    expect(seals).toHaveLength(1);
    const variants = [
      ["red, tilted", [225, 68, 70], true],
      ["blue, tilted", [54, 111, 227], true],
      ["yellow, flat", [241, 214, 83], false],
      ["green, tilted", [75, 170, 103], true],
      ["black, flat", [24, 24, 24], false],
    ];
    let finderOnly = 0, pageAligned = 0;
    for (const [name, ink, tilted] of variants) {
      const photo = printAndPhotograph(seals, { ink, tilted, finderBlocked: true });
      // Both variants consume the same production page scanner's work
      // budget. The option is an explicit rollback switch for the new
      // page-aligned decoder, not a hint containing the original PDF layout.
      const legacy = await scanPdfPage(photo, { pageAligned: false });
      finderOnly += Number(legacy.seals.includes(seals[0]));
      const { seals: collected } = await scanPdfPage(photo, { pageAligned: true });
      if (collected.includes(seals[0])) {
        console.info(`WM-08 verified case: ${name}`);
        expect(await verifyQRedSeals(collected, publicKey)).toMatchObject({ status: "VALID", content });
        pageAligned++;
      }
    }
    // Report the real measured values; a successful visible QRED.ORG marker
    // or a synthetic geometry helper alone is not a successful signed page.
    console.info(`WM-08 signed page recoveries: finder-only=${finderOnly}/5, page-aligned=${pageAligned}/5`);
    expect(pageAligned).toBeGreaterThanOrEqual(4);
    expect(pageAligned - finderOnly).toBeGreaterThanOrEqual(3);
  }, 120000);
});
