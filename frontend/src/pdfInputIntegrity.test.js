import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnnotationFlags, PDFDict, PDFDocument, PDFHexString, PDFName, PDFObjectCopier } from "pdf-lib";
import { PNG } from "pngjs";
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

it.each(["filled", "blank", "missing-appearance", "multiline", "repeated-widget", "fields-only"])("automatically flattens %s forms before signing", async (kind) => {
  const pdf = await makeForm();
  const field = pdf.getForm().getTextField("amount");
  if (kind === "fields-only") pdf.getPage(0).node.delete(PDFName.of("Contents"));
  let value = "12345.67 dollars";
  if (kind === "blank") value = "";
  if (kind === "multiline") {
    value = "12345.67 dollars\nApproved";
    field.enableMultiline();
    field.acroField.getWidgets()[0].setRectangle({ x: 180, y: 620, width: 200, height: 80 });
  }
  field.setText(value);
  if (kind === "repeated-widget") {
    const page = pdf.addPage([612, 792]);
    page.drawText("Copy of amount:", { x: 72, y: 700, size: 12 });
    field.addToPage(page, { x: 180, y: 690, width: 200, height: 25 });
  }
  pdf.getForm().updateFieldAppearances();
  if (kind === "missing-appearance") field.acroField.getWidgets()[0].dict.delete(PDFName.of("AP"));
  const file = asFile(await pdf.save({ updateFieldAppearances: false }));
  const { blob, pageSealResults, flattenedFieldCount } = await sealPdfInBrowser({ ...options, file });
  expect(flattenedFieldCount).toBe(1);
  expect(pageSealResults).toHaveLength(kind === "repeated-widget" ? 2 : 1);
  for (const result of pageSealResults) {
    const verified = await verifyQRedSeals(result.seals, publicKey);
    expect(verified.status).toBe("VALID");
    if (value) expect(verified.content).toContain("12345.67 dollars");
    if (kind === "multiline") expect(verified.content).toContain("Approved");
  }
  const output = await PDFDocument.load(await blob.arrayBuffer());
  expect(output.getForm().getFields()).toHaveLength(0);
  for (const page of output.getPages()) expect(page.node.Annots()?.size() || 0).toBe(0);
  const text = await extractPdfText(blob);
  if (value) expect(text).toContain("12345.67 dollars");
  if (kind === "blank") expect(text).not.toContain("12345.67 dollars");
});

it.each([true, false])("handles Unicode form text without dropping characters (saved appearance: %s)", async (hasAppearance) => {
  const pdf = await makeForm();
  const field = pdf.getForm().getTextField("amount");
  field.acroField.setValue(PDFHexString.fromText(japanese));
  const widget = field.acroField.getWidgets()[0];
  if (hasAppearance) {
    const source = await PDFDocument.load(readFileSync("../tests/fixtures/cjk-text.pdf"));
    const fonts = source.getPage(0).node.Resources().lookup(PDFName.of("Font"), PDFDict);
    const [, font] = fonts.entries().find(([, ref]) => source.context.lookup(ref, PDFDict).get(PDFName.of("Subtype")) === PDFName.of("Type0"));
    const copiedFont = PDFObjectCopier.for(source.context, pdf.context).copy(font);
    const { width, height } = widget.getRectangle();
    const encoded = Buffer.from(japanese, "utf16le").swap16().toString("hex");
    const appearance = pdf.context.flateStream(`BT /F1 12 Tf 1 0 0 1 4 8 Tm <${encoded}> Tj ET`, {
      Type: "XObject", Subtype: "Form", BBox: [0, 0, width, height], Resources: { Font: { F1: copiedFont } },
    });
    widget.setNormalAppearance(pdf.context.register(appearance));
  } else {
    widget.dict.delete(PDFName.of("AP"));
  }
  const file = asFile(await pdf.save({ updateFieldAppearances: false }));
  if (!hasAppearance) {
    await expect(sealPdfInBrowser({ ...options, file })).rejects.toThrow(/Cannot safely flatten.*WinAnsi/);
    return;
  }
  const { blob, sealResult } = await sealPdfInBrowser({ ...options, file });
  expect((await verifyQRedSeals(sealResult.seals, publicKey)).content).toContain(japanese);
  expect(await extractPdfText(blob)).toContain(japanese);
});

it.each(["orphan-widget", "xfa", "password", "hidden", "signature", "stale-appearance", "bad-geometry", "overlapping"])("rejects %s forms instead of changing or losing values", async (kind) => {
  const pdf = await makeForm();
  const field = pdf.getForm().getTextField("amount");
  if (kind === "orphan-widget") pdf.catalog.delete(PDFName.of("AcroForm"));
  if (kind === "xfa") {
    const acroForm = pdf.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
    acroForm.delete(PDFName.of("Fields"));
    pdf.getPage(0).node.delete(PDFName.of("Annots"));
    acroForm.set(PDFName.of("XFA"), pdf.context.register(pdf.context.stream("<xdp:xdp xmlns:xdp='http://ns.adobe.com/xdp/'/>")));
  }
  if (kind === "password") field.enablePassword();
  if (kind === "hidden") field.acroField.getWidgets()[0].setFlag(AnnotationFlags.Hidden);
  if (kind === "signature") field.acroField.dict.set(PDFName.of("FT"), PDFName.of("Sig"));
  if (kind === "stale-appearance") field.acroField.setValue(PDFHexString.fromText("99999.99 dollars"));
  if (kind === "bad-geometry") field.acroField.getWidgets()[0].setRectangle({ x: 180, y: 690, width: 400, height: 25 });
  if (kind === "overlapping") {
    const cover = pdf.getForm().createTextField("cover");
    cover.setText("A different amount");
    cover.addToPage(pdf.getPage(0), { x: 180, y: 690, width: 200, height: 25 });
    const annotations = pdf.getPage(0).node.Annots().asArray().reverse();
    pdf.getPage(0).node.set(PDFName.of("Annots"), pdf.context.obj(annotations));
  }
  const file = asFile(await pdf.save({ updateFieldAppearances: false }));
  await expect(sealPdfInBrowser({ ...options, file })).rejects.toThrow(/Cannot safely flatten/);
});

it("preserves text, dropdowns, and checkbox/radio appearances in the printed output", async () => {
  const pdf = await makeForm();
  const page = pdf.getPage(0);
  const form = pdf.getForm();
  const choice = form.createDropdown("currency");
  choice.addOptions(["USD", "EUR"]);
  choice.select("USD");
  choice.addToPage(page, { x: 72, y: 630, width: 120, height: 25 });
  for (const checked of [true, false]) {
    const box = form.createCheckBox(`approved-${checked}`);
    box.addToPage(page, { x: checked ? 72 : 120, y: 580, width: 20, height: 20 });
    if (checked) box.check();
  }
  const radio = form.createRadioGroup("decision");
  radio.addOptionToPage("yes", page, { x: 72, y: 530, width: 20, height: 20 });
  radio.addOptionToPage("no", page, { x: 120, y: 530, width: 20, height: 20 });
  radio.select("no");
  const source = await pdf.save();
  const { blob, sealResult, flattenedFieldCount } = await sealPdfInBrowser({ ...options, file: asFile(source) });
  expect(flattenedFieldCount).toBe(5);
  const verified = await verifyQRedSeals(sealResult.seals, publicKey);
  expect(verified.status).toBe("VALID");
  expect(verified.content).toContain("USD");
  expect(verified.content).toContain("12345.67 dollars");
  const folder = mkdtempSync(join(tmpdir(), "qred-form-render-"));
  try {
    const output = new Uint8Array(await blob.arrayBuffer());
    const images = [source, output].map((bytes, index) => {
      const input = join(folder, `${index}.pdf`);
      const rendered = join(folder, String(index));
      writeFileSync(input, bytes);
      execFileSync("pdftoppm", ["-r", "72", "-singlefile", "-png", input, rendered]);
      return PNG.sync.read(readFileSync(`${rendered}.png`));
    });
    // Letter -> legal adds the seal footer below the original page. Every
    // original content pixel, including selected controls, must stay intact.
    expect(images[1].width).toBe(images[0].width);
    expect(images[1].data.subarray(0, images[0].data.length)).toEqual(images[0].data);
    const text = execFileSync("pdftotext", [join(folder, "1.pdf"), "-"], { encoding: "utf8" });
    expect(text).toContain("12345.67 dollars");
    expect(text).toContain("USD");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
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
