import { PDFDocument, StandardFonts } from "pdf-lib";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { expect, it } from "vitest";
import { renderPdfPage, withPdfDocument } from "./readPdfText.js";
import { watermarkMarginForPage } from "./watermarkPlacement.js";

it.each([StandardFonts.Helvetica, StandardFonts.TimesRoman, StandardFonts.Courier])(
  "renders unembedded %s from bundled font data rather than host fonts", async name => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(name);
    pdf.addPage([612, 792]).drawText("Narrow original content ABC 123", { x: 28, y: 400, size: 12, font });
    const file = new File([await pdf.save()], "standard-font.pdf", { type: "application/pdf" });
    await withPdfDocument(file, async document => {
      const page = await document.getPage(1);
      const { fnArray, argsArray } = await page.getOperatorList();
      const index = fnArray.indexOf(OPS.setFont);
      expect(index).toBeGreaterThanOrEqual(0);
      const loaded = await new Promise(resolve => page.commonObjs.get(argsArray[index][0], resolve));
      // PDF.js otherwise accepts an OS substitution and can silently paint no
      // letters. Checking ink alone can pass on a developer's installed fonts.
      expect(loaded.missingFile).toBe(false);
      expect((await page.getTextContent()).items.map(item => item.str).join("")).toContain("ABC 123");
      const image = await renderPdfPage(document, 1);
      expect(Object.keys(loaded.compiledGlyphs).length).toBeGreaterThan(10);
      expect(watermarkMarginForPage(image)).toBe(36);
      let ink = 0;
      for (let i = 0; i < image.data.length; i += 4) if (image.data[i] < 100) ink++;
      expect(ink).toBeGreaterThan(300);
    });
  });
