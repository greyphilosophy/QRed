import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { expect, it } from "vitest";
import { generateSigningKeyPair } from "../signingKeys.js";
import { sealPdfInBrowser } from "../pdfClientSeal.js";
import { verifyQRedSeals } from "../qredVerifier.js";
import { addSourceReadings } from "./sourceOcr.js";

const box = y => ({ x: .1, y, width: .7, height: .05 });
function word(text, y, lineId, confidence = 99) {
  return { text, lineId, confidence, bbox: { x0: .12, x1: .35, y0: y + .01, y1: y + .04 } };
}

it("keeps native wording, blank lines and separate occurrences of the same lettering", () => {
  const native = "Room number 819\n\nHARBOR INN";
  const result = addSourceReadings(native, [box(.4), box(.8)], [
    word("HARBOR INN", .1, 0), word("Room nurnber 819", .4, 1), word("HARBOR INN", .8, 2),
    word("blot", .6, 3, 10), word("|", .7, 4),
  ]);
  expect(result.text).toBe("HARBOR INN\nRoom number 819\n\nHARBOR INN");
  expect(result.lines.map(line => line.y)).toEqual([.11, .4, .8]);
  expect(result.ocrReadings).toEqual([{ line: 1, observed: "Room nurnber 819" }]);
  expect(addSourceReadings("Invoice", [box(.4)], [word("Unrelated", .4, 0)]).ocrReadings).toEqual([]);
});

it("reads actual raster lettering and signs its location even when the footer has identical native text", async () => {
  const pdf = await PDFDocument.create(), page = pdf.addPage([480, 600]);
  const canvas = createCanvas(700, 160), ctx = canvas.getContext("2d");
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, 700, 160);
  ctx.fillStyle = "black"; ctx.font = "bold 64px sans-serif";
  ctx.fillText("HARBOR INN", 30, 80);
  const logo = await pdf.embedPng(canvas.toBuffer("image/png"));
  page.drawImage(logo, { x: 90, y: 465, width: 315, height: 72 });
  page.drawText("Invoice 2017", { x: 70, y: 360, size: 18 });
  page.drawText("HARBOR INN", { x: 70, y: 40, size: 18 });
  pdf.addPage([480, 600]).drawImage(logo, { x: 90, y: 465, width: 315, height: 72 });
  const file = new File([await pdf.save()], "synthetic-lettering.pdf", { type: "application/pdf" });
  const keys = await generateSigningKeyPair();
  const result = await sealPdfInBrowser({ file, ...keys, pageScalingStrategy: "seal-sheets" });
  const seal = await verifyQRedSeals(result.pageSealStrings[0], keys.publicKey);
  expect(result.ocrUnavailablePages).toEqual([]);
  expect(seal).toMatchObject({ status: "VALID", content: "HARBOR INN\nInvoice 2017\nHARBOR INN" });
  const rasterPage = await verifyQRedSeals(result.pageSealStrings[1], keys.publicKey);
  expect(rasterPage).toMatchObject({ status: "VALID", content: "HARBOR INN" });
  expect(seal.evidence.layout.lines[0].y).toBeLessThan(.25);
  expect(seal.evidence.layout.lines[2].y).toBeGreaterThan(.85);
}, 30000);
