import jsQR from "jsqr";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { expect, it } from "vitest";
import { sealPdfInBrowser } from "../pdfClientSeal.js";
import { createQRedSeals } from "../qredSealer.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { qredPayloadFromScanResult } from "../qr/qrPayload.js";
import { scanQrImage } from "../qr/scanQrImage.js";
import { ENTRY_URL } from "./navigationQr.js";
import { planFooterLayout } from "./qrLayout.js";
import { renderPdfPage, withPdfDocument } from "./readPdfText.js";
import { renderSealedPdf } from "./renderSealedPdf.js";

const keys = { privateKey: "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes",
  publicKey: "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q" };
const caption = "Verify at qred.org";

function crop(image, box) {
  const left = Math.floor(box.x * image.scale);
  const top = Math.floor((image.bounds.height - box.y - box.height) * image.scale);
  const width = Math.ceil(box.width * image.scale), height = Math.ceil(box.height * image.scale);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    const offset = ((top + row) * image.width + left) * 4;
    data.set(image.data.subarray(offset, offset + width * 4), row * width * 4);
  }
  return { data, width, height };
}

function sealBox(layout, index) {
  return { x: layout.footerMargin + (layout.qrOffsetX ?? 10) +
      (index % layout.columns) * (layout.qrSize + layout.gap),
    y: layout.footerMargin + (layout.qrOffsetY ?? 10) +
      (layout.rows - Math.floor(index / layout.columns) - 1) * (layout.qrSize + layout.gap),
    width: layout.qrSize, height: layout.qrSize };
}

it.each(["legal-footer", "shrink-footer", "automatic"])(
  "prints the link only on the first page's footer in %s mode", async strategy => {
    const source = await PDFDocument.create();
    for (let i = 0; i < 2; i++) {
      const page = source.addPage([612, 792]);
      // Automatic must also add the link when a blank first page needs a footer.
      if (strategy !== "automatic") page.drawText(`Footer navigation page ${i + 1}`, { x: 72, y: 720, size: 12 });
    }
    const font = await source.embedFont(StandardFonts.Helvetica);
    const file = new File([await source.save()], "footer-navigation.pdf", { type: "application/pdf" });
    const result = await sealPdfInBrowser({ file, ...keys, pageScalingStrategy: strategy });
    if (strategy === "automatic") expect(result.footerPages).toEqual([1, 2]);
    const firstLayout = planFooterLayout(612, result.pageSealStrings[0].length, {
      legal: strategy !== "shrink-footer", navigation: true, captionWidth: font.widthOfTextAtSize(caption, 9),
    });
    await withPdfDocument(result.blob, async pdf => {
      for (const number of [1, 2]) {
        const image = await renderPdfPage(pdf, number, 150 / 72);
        const link = crop(image, firstLayout.entry);
        expect(jsQR(link.data, link.width, link.height)?.data ?? null).toBe(number === 1 ? ENTRY_URL : null);
        const { items } = await (await pdf.getPage(number)).getTextContent();
        expect(items.filter(item => item.str === caption)).toHaveLength(1);
        const footer = crop(image, { x: 0, y: 0, width: 612, height: firstLayout.footerHeight });
        const seal = qredPayloadFromScanResult(scanQrImage(footer.data, footer.width, footer.height));
        expect(seal).toBe(result.pageSealStrings[number - 1][0]);
        await expect(verifyQRedSeals([seal], keys.publicKey)).resolves.toMatchObject({ status: "VALID" });
      }
    });
  }, 60000);

it.each(["legal-footer", "shrink-footer"])("keeps all four seals and the navigation link readable in %s mode", async strategy => {
  const content = "Four-part footer navigation regression. ".repeat(80).trimEnd();
  const signed = await createQRedSeals({ ...keys, content, encodingStrategy: "plaintext", preferFourQrPage: true,
    pageContext: { pageNumber: 1, pageCount: 1 } });
  expect(signed.seals).toHaveLength(4);
  const source = await PDFDocument.create();
  source.addPage([612, 792]).drawText("Synthetic four-part seal", { x: 72, y: 720, size: 12 });
  const font = await source.embedFont(StandardFonts.Helvetica);
  const file = new File([await source.save()], "four-seal-footer.pdf", { type: "application/pdf" });
  const result = await renderSealedPdf({ file, pageSealResults: [signed], pagesWithText: [true], pageScalingStrategy: strategy });
  const layout = planFooterLayout(612, 4, { legal: strategy === "legal-footer", navigation: true,
    captionWidth: font.widthOfTextAtSize(caption, 9) });
  await withPdfDocument(result.blob, async pdf => {
    const image = await renderPdfPage(pdf, 1, 300 / 72);
    const link = crop(image, layout.entry);
    expect(jsQR(link.data, link.width, link.height)?.data).toBe(ENTRY_URL);
    const seals = signed.seals.map((_, index) => {
      const qr = crop(image, sealBox(layout, index));
      return qredPayloadFromScanResult(scanQrImage(qr.data, qr.width, qr.height));
    });
    expect(seals).toEqual(signed.seals);
    await expect(verifyQRedSeals(seals, keys.publicKey)).resolves.toMatchObject({ status: "VALID", content });
  });
}, 60000);

it("keeps navigation, caption and seal quiet zones separate across page sizes and grid counts", () => {
  for (const legal of [false, true]) for (const width of [300, 595, 612, 842]) for (const count of [1, 2, 3, 4]) {
    const layout = planFooterLayout(width, count, { legal, navigation: true, captionWidth: 66 });
    const boxes = [...Array.from({ length: count }, (_, index) => sealBox(layout, index)), layout.entry,
      { x: layout.caption.x, y: layout.caption.y - 2, width: 66, height: 11 }];
    for (const [i, box] of boxes.entries()) {
      expect(box.x).toBeGreaterThanOrEqual(18);
      expect(box.x + box.width).toBeLessThanOrEqual(width - 18);
      expect(box.y).toBeGreaterThanOrEqual(18);
      expect(box.y + box.height).toBeLessThanOrEqual(layout.footerHeight);
      for (const other of boxes.slice(i + 1)) {
        const overlaps = box.x < other.x + other.width && box.x + box.width > other.x &&
          box.y < other.y + other.height && box.y + box.height > other.y;
        expect(overlaps, JSON.stringify({ width, count, legal, box, other })).toBe(false);
      }
    }
  }
});
