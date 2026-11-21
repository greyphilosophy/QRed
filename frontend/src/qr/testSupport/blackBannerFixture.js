import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { stampWatermarks } from "../../pdf/watermark.js";
import { renderPdfPage, withPdfDocument } from "../../pdf/readPdfText.js";

const directory = "../tests/fixtures/black-banner/";
export const bannerReference = JSON.parse(readFileSync(`${directory}expected.json`, "utf8"));
const names = {
  control: "QRed_White_Background_Control.pdf",
  normal: "QRed_Black_Bar_Test.pdf",
  tall: "QRed_Tall_Black_Bar_Test.pdf",
};

export function bannerFile(kind) {
  return new File([readFileSync(directory + names[kind])], names[kind], { type: "application/pdf" });
}

// Every source carries identical words at identical positions. Stamp the same
// signed payload and geometry so only the banner's pixels vary. The expected
// seal is an assertion oracle, never an argument to the production decoder.
export async function renderBanner(kind) {
  const pdf = await PDFDocument.load(await bannerFile(kind).arrayBuffer());
  await stampWatermarks(pdf, [{ pageAligned: true,
    boxes: [{ x: 54, y: 54, width: 504, height: 684 }] }], [bannerReference]);
  return withPdfDocument(new Blob([await pdf.save()]), document => renderPdfPage(document, 1, 2));
}

export function framedBanner(image) {
  const margin = 60, width = image.width + margin * 2, height = image.height + margin * 2;
  const data = new Uint8ClampedArray(width * height * 4).fill(51);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  for (let y = 0; y < image.height; y++) {
    data.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
      ((y + margin) * width + margin) * 4);
  }
  return { data, width, height };
}
