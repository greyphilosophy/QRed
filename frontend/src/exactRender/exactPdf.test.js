import { beforeAll, describe, expect, it } from "vitest";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { PDFDocument, degrees, rgb } from "pdf-lib";
import { sealExactPdf, verifyExactPdf } from "./exactPdf.js";
import { EXACT_PROFILE, renderExactPage, withExactDocument } from "./renderer.js";
import { scanErasureSeals } from "../qr/scanErasureSeals.js";
import { verifyQRedSeals } from "../qredVerifier.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=", publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";
async function source(pages = 1) {
  const pdf = await PDFDocument.create();
  for (let number = 1; number <= pages; number++) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`QRed exact appearance fixture ${number}: amount 605.29`, { x: 72, y: 720, size: 12 });
  }
  return new Blob([await pdf.save()], { type: "application/pdf" });
}
describe("isolated exact PDF pipeline (Node test profile, not browser qualification)", () => {
  let sealed;
  beforeAll(async () => {
    globalThis.ImageData = ImageData;
    globalThis.document = { createElement: () => createCanvas(1, 1) };
    sealed = await sealExactPdf({ file: await source(), privateKey, publicKey });
  }, 30000);
  it("completes actual optical recovery with the single-page signed root", async () => {
    expect(EXACT_PROFILE).toContain("node-test");
    expect(sealed.completeExactRenderedDocument).toBe(true);
    const fresh = await verifyExactPdf({ file: sealed.blob, publicKey });
    expect(fresh.completeExactRenderedDocument).toBe(true);
    expect(fresh.pages[0]).toMatchObject({ signatureStatus: "VALID", exactRender: { status: "exact-render-match" } });
  }, 30000);
  it("old readers reject the separate evidence body instead of presenting it as text", async () => {
    const image = await withExactDocument(sealed.blob, pdf => renderExactPage(pdf, 1));
    const result = await verifyQRedSeals(await scanErasureSeals(image), publicKey);
    expect(result.status).toBe("ERROR");
    expect(result.error_message).toContain("Unsupported page evidence format");
    expect(result.content).toBeUndefined();
  });
  it.each(["visible", "faint", "outline"])("rejects %s painted additions", async variant => {
    const pdf = await PDFDocument.load(await sealed.blob.arrayBuffer()), page = pdf.getPage(0);
    if (variant === "outline") page.drawSvgPath("M0 0 L0 -12 L12 -12 L12 0", { x: 74, y: 718, borderColor: rgb(0, 0, 0), borderWidth: .5 });
    else page.drawText("X", { x: 74, y: 718, size: 12, color: rgb(...Array(3).fill(variant === "faint" ? .996 : 0)) });
    const result = await verifyExactPdf({ file: new Blob([await pdf.save()]), publicKey });
    expect(result.completeExactRenderedDocument).toBe(false);
    expect(result.pages[0].signatureStatus).toBe("VALID");
    expect(result.pages[0].exactRender.status).toBe("inconclusive");
  }, 30000);
  it("explicitly leaves hidden text and metadata outside the raster claim", async () => {
    const pdf = await PDFDocument.load(await sealed.blob.arrayBuffer());
    pdf.setSubject("Metadata is outside the exact appearance claim");
    pdf.getPage(0).drawText("HIDDEN CHANGE", { x: 72, y: 720, size: 12, opacity: 0 });
    expect((await verifyExactPdf({ file: new Blob([await pdf.save()]), publicKey })).completeExactRenderedDocument).toBe(true);
  }, 30000);
  it("requires a trusted key before parsing or comparing evidence", async () => {
    const result = await verifyExactPdf({ file: sealed.blob, publicKey: "" });
    expect(result.completeExactRenderedDocument).toBe(false);
    expect(result.pages[0]).toMatchObject({ signatureStatus: "UNVERIFIED", exactRender: { status: "inconclusive" } });
  });
  it("validates a whole ordered two-page document and rejects reordered pages", async () => {
    const result = await sealExactPdf({ file: await source(2), privateKey, publicKey });
    expect(result.completeExactRenderedDocument).toBe(true);
    const original = await PDFDocument.load(await result.blob.arrayBuffer()), reordered = await PDFDocument.create();
    for (const page of await reordered.copyPages(original, [1, 0])) reordered.addPage(page);
    const checked = await verifyExactPdf({ file: new Blob([await reordered.save()]), publicKey });
    expect(checked.completeExactRenderedDocument).toBe(false);
    expect(checked.pages.every(page => page.exactRender.status === "inconclusive")).toBe(true);
  }, 30000);
  it("refuses unsupported source geometry, crowded pages, and aborts", async () => {
    const pdf = await PDFDocument.load(await (await source()).arrayBuffer());
    pdf.getPage(0).setRotation(degrees(90));
    await expect(sealExactPdf({ file: new Blob([await pdf.save()]), privateKey, publicKey })).rejects.toThrow(/unrotated/);
    pdf.getPage(0).setRotation(degrees(0));
    pdf.getPage(0).drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(.99, .99, .99) });
    await expect(sealExactPdf({ file: new Blob([await pdf.save()]), privateKey, publicKey })).rejects.toThrow(/white space/);
    const controller = new AbortController(); controller.abort();
    await expect(verifyExactPdf({ file: sealed.blob, publicKey, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  }, 30000);
});
