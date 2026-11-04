import { PDFDocument, StandardFonts } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { expect, it, vi } from "vitest";
import { renderPdfPage, withPdfDocument } from "./readPdfText.js";

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, getDocument: vi.fn(actual.getDocument) };
});

it("renders alphabetic standard-font glyphs from bundled font data in Node", async () => {
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  source.addPage([240, 100]).drawText("Alphabetic glyphs", {
    x: 20, y: 40, size: 18, font,
  });
  const file = new File([await source.save()], "alphabetic-glyphs.pdf", { type: "application/pdf" });
  const image = await withPdfDocument(file, pdf => renderPdfPage(pdf, 1));

  // Node's canvas fallback can silently omit letters while still drawing
  // numbers. It must use PDF.js's bundled font programs, not system fonts.
  expect(getDocument).toHaveBeenLastCalledWith(expect.objectContaining({
    useSystemFonts: false,
    standardFontDataUrl: expect.stringMatching(/\/standard_fonts\/$/),
  }));
  let darkPixels = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if (Math.min(image.data[i], image.data[i + 1], image.data[i + 2]) < 128) darkPixels++;
  }
  // This page contains letters only. Extractable text alone would not prove
  // that the raster used by visual evidence and watermark preflight has ink.
  expect(darkPixels).toBeGreaterThan(500);
});
