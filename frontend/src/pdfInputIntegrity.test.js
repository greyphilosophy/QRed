import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { expect, it } from "vitest";
import { extractPdfText, sealPdfInBrowser } from "./pdfClientSeal.js";
import { verifyQRedSeals } from "./qredVerifier.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";
const options = { issuer: "PDF regression QA", privateKey, publicKey };
const japanese = "承認金額は一万円です";
const asFile = (bytes) => new File([bytes], "input.pdf", { type: "application/pdf" });

async function makeForm() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  page.drawText("Invoice amount:", { x: 72, y: 700, size: 12 });
  const field = pdf.getForm().createTextField("amount");
  field.setText("12345.67 dollars");
  field.addToPage(page, { x: 180, y: 690, width: 200, height: 25 });
  return pdf;
}

it("signs both Latin and CJK text and preserves them in the stamped PDF", async () => {
  const file = asFile(readFileSync("../tests/fixtures/cjk-text.pdf"));
  const text = await extractPdfText(file);
  expect(text).toContain("Invoice 123");
  expect(text).toContain(japanese);
  const { blob, sealResult } = await sealPdfInBrowser({ ...options, file });
  const verified = await verifyQRedSeals(sealResult.seals, publicKey);
  expect(verified.status).toBe("VALID");
  expect(verified.content).toContain(japanese);
  expect(await extractPdfText(blob)).toContain(japanese);
});

it.each([false, true])("rejects a partly readable page with a failed font (embedded form: %s)", async (embedded) => {
  const pdf = await PDFDocument.load(readFileSync("../tests/fixtures/cjk-text.pdf"));
  const fonts = pdf.getPage(0).node.Resources().lookup(PDFName.of("Font"), PDFDict);
  for (const [, ref] of fonts.entries()) {
    const font = pdf.context.lookup(ref, PDFDict);
    if (font.get(PDFName.of("Subtype")) === PDFName.of("Type0")) {
      font.set(PDFName.of("Encoding"), PDFName.of("Missing-CMap"));
    }
  }
  let bytes = await pdf.save();
  if (embedded) {
    const wrapper = await PDFDocument.create();
    const [page] = await wrapper.embedPdf(bytes);
    wrapper.addPage([612, 792]).drawPage(page);
    bytes = await wrapper.save();
  }
  await expect(sealPdfInBrowser({ ...options, file: asFile(bytes) })).rejects.toThrow(/Cannot reliably read all text/);
});

it.each(["filled", "blank", "orphan-widget", "xfa"])("rejects %s interactive forms before creating any seals", async (kind) => {
  const pdf = await makeForm();
  if (kind === "blank") pdf.getForm().getTextField("amount").setText("");
  if (kind === "orphan-widget") pdf.catalog.delete(PDFName.of("AcroForm"));
  if (kind === "xfa") {
    const acroForm = pdf.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
    acroForm.delete(PDFName.of("Fields"));
    pdf.getPage(0).node.delete(PDFName.of("Annots"));
    acroForm.set(PDFName.of("XFA"), pdf.context.register(pdf.context.stream("<xdp:xdp xmlns:xdp='http://ns.adobe.com/xdp/'/>")));
  }
  const file = asFile(await pdf.save({ updateFieldAppearances: kind !== "xfa" }));
  await expect(sealPdfInBrowser({ ...options, file })).rejects.toThrow(/interactive form fields.*Flatten or print/);
});

it("keeps a checked flattened form's amount in both the signature and output PDF", async () => {
  const pdf = await makeForm();
  pdf.getForm().flatten();
  const file = asFile(await pdf.save());
  const { blob, sealResult } = await sealPdfInBrowser({ ...options, file });
  const verified = await verifyQRedSeals(sealResult.seals, publicKey);
  expect(verified.status).toBe("VALID");
  expect(verified.content).toContain("Invoice amount:");
  expect(verified.content).toContain("12345.67 dollars");
  const folder = mkdtempSync(join(tmpdir(), "qred-form-"));
  try {
    const output = join(folder, "sealed.pdf");
    writeFileSync(output, new Uint8Array(await blob.arrayBuffer()));
    const printedText = execFileSync("pdftotext", [output, "-"], { encoding: "utf8" });
    expect(printedText).toContain("Invoice amount:");
    expect(printedText).toContain("12345.67 dollars");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
