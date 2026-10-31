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
import { hiddenPayloadFromScanResult } from "./hiddenPayload.js";
import { scanQrImage } from "./scanQrImage.js";
import { scanPdfPage } from "../verifier/scanPdf.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";
const pageSize = { width: 612, height: 792 };
const margin = 18;
const SYNTHETIC_ONLY = "All documents in this test are generated in memory.";

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
} = {}) {
  const symbols = seals.map(seal => createQRedQrSymbol(seal));
  if (![0, 1, 4].includes(symbols.length)) throw new Error("Fixture supports 0, 1 or 4 QR chunks");
  const boxes = symbols.length === 1
    ? [{ x: 0.03, y: 0.03, w: 0.94, h: 0.94 }]
    : symbols.map((_, i) => ({
      x: 0.03 + (i % 2) * 0.47, y: 0.03 + Math.floor(i / 2) * 0.47, w: 0.47, h: 0.47,
    }));
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
      outputColor(rgba, offset, [43, 43, 47]);
      continue;
    }
    // Apply uneven lighting and slight deterministic photo noise.
    const paper = 246 - 10 * v - 3 * u + ((px * 7 + py * 13) % 5 - 2);
    let value = paper;
    let localRow = -1, localCol = -1, matchedPart = -1;
    for (let part = 0; part < symbols.length; part++) {
      const box = boxes[part];
      if (u < box.x || u >= box.x + box.w || v < box.y || v >= box.y + box.h) continue;
      const size = symbols[part].modules.size;
      localCol = Math.floor((u - box.x) / box.w * size);
      localRow = Math.floor((v - box.y) / box.h * size);
      value = paper * (symbols[part].modules.get(localRow, localCol) ? 0.85 : 1);
      matchedPart = part;
      break;
    }
    let pixel = [value, value, value];
    // Horizontal colored or black letter strokes cross modules but leave
    // exposed pixels elsewhere. Color is deliberately unrelated to QR bits.
    if (text && u > 0.09 && u < 0.91 && v > 0.14 && v < 0.86 &&
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

  it("[WM-02] actually PRINTS the stretched module grid at its rectangular coordinates", async () => {
    const payload = (await signed("Rectangular watermark renderer check.")).seals[0];
    const qr = createQRedQrSymbol(payload);
    const box = { x: 18, y: 18, width: 576, height: 756 };
    const pdf = await PDFDocument.create();
    pdf.addPage([pageSize.width, pageSize.height]);
    await stampWatermarks(pdf, [{ boxes: [box] }], [{ seals: [payload] }]);
    const file = new Blob([await pdf.save()], { type: "application/pdf" });
    const image = await withPdfDocument(file, instance => renderPdfPage(instance, 1, 2));
    const n = qr.modules.size;
    // One of the dark pixels in the bottom-left and top-right finder cores.
    for (const [row, col] of [[n - 4, 3], [3, n - 4]]) {
      expect(qr.modules.get(row, col)).toBe(true);
      const x = box.x + (4 + col + 0.5) * box.width / (n + 8);
      const y = box.y + box.height - (4 + row + 0.5) * box.height / (n + 8);
      expect(sampleAtPagePoint(image, x, y), `finder module ${row},${col}`).toBeLessThan(239);
    }
  }, 30000);

  it("[WM-01, WM-03, WM-05] recovers signed bytes from a perspective sheet with one unreadable finder", async () => {
    const content = "PAGE COORDINATE CHALLENGE\n" + "Inventory and inspection text. ".repeat(25);
    const { seals } = await signed(content);
    expect(seals).toHaveLength(1);
    const photo = printAndPhotograph(seals, { ink: [223, 62, 67] });
    const { seals: recovered } = await scanPdfPage(photo);
    expect(recovered).toContain(seals[0]);
    await expect(verifyQRedSeals(recovered, publicKey)).resolves.toMatchObject({ status: "VALID", content });
  }, 120000);

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
    expect(SYNTHETIC_ONLY).toContain("generated in memory");
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
    for (const [_name, ink, tilted] of variants) {
      const photo = printAndPhotograph(seals, { ink, tilted, finderBlocked: true });
      const conventional = scanQrImage(photo.data, photo.width, photo.height,
        { tryRescaling: false, maxAttempts: 3 });
      finderOnly += Number(hiddenPayloadFromScanResult(conventional) === seals[0]);
      const { seals: collected } = await scanPdfPage(photo);
      if (collected.includes(seals[0])) {
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
