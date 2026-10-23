import { describe, expect, it } from "vitest";
import { PDFDocument, degrees, rgb } from "pdf-lib";
import { signAsync } from "@noble/ed25519";
import { sealPdfInBrowser } from "./pdfClientSeal.js";
import { verifyQRedSeals } from "./qredVerifier.js";
import { verifySealCollection } from "./sealCollection.js";
import { computeKeyId } from "./qredSealer.js";
import { attestationMessage, pageCommitment } from "./attestation.js";
import { decodeBase64Url, encodeBase64Url } from "./sealFormat.js";
import { renderPdfPage, withPdfDocument } from "./pdf/readPdfText.js";
import { visiblePageGeometry } from "./pdf/pageScaling.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";
const asFile = async pdf => new File([await pdf.save()], "synthetic-visual.pdf", { type: "application/pdf" });

async function mixedDocument() {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]).drawText("Account 123456\nAmount 50.00", { x: 50, y: 720, size: 12 });
  const image = pdf.addPage([612, 792]);
  image.drawCircle({ x: 150, y: 500, size: 80, color: rgb(0.1, 0.5, 0.8) });
  const other = pdf.addPage([612, 792]);
  other.drawRectangle({ x: 250, y: 150, width: 200, height: 300, color: rgb(0.6, 0.2, 0.1) });
  pdf.addPage([612, 792]);
  return asFile(pdf);
}

describe("PDF visual references", () => {
  it("distinguishes two graphic pages and a blank page, then sorts reversed scans", async () => {
    const { pageSealStrings, footerPages } = await sealPdfInBrowser({ file: await mixedDocument(), privateKey, publicKey, pageScalingStrategy: "watermark" });
    expect(footerPages).toEqual([2, 3, 4]);
    expect(pageSealStrings.every(seals => seals.length === 1)).toBe(true);
    const results = await verifySealCollection(pageSealStrings.flat().reverse(), publicKey);
    expect(results.map(result => result.page_number)).toEqual([1, 2, 3, 4]);
    expect(results.every(result => result.status === "VALID")).toBe(true);
    expect(new Set(results.map(result => result.document_root)).size).toBe(1);
    expect(new Set(results.map(result => result.page_hash)).size).toBe(4);
    expect(results[0].content).toContain("Account 123456");
    expect(results[0].evidence.layout.lines).toHaveLength(2);
    expect(results[1].evidence.visual).toBeTruthy();
    expect(results[2].evidence.visual).toBeTruthy();
    expect(results[3].evidence.blank).toBe(true);
  }, 30000);
  it("attests the same mixed pages with private binary commitments and verifies them offline", async () => {
    const key_id = await computeKeyId(publicKey), seen = [];
    const metadata = { key_id, timestamp: "2026-10-23T12:00:00.000Z", identity: {
      provider: "google", name_source: "google", email: "person@example.com", name: "Example Person", subject: "test" } };
    const { pageSealStrings } = await sealPdfInBrowser({ file: await mixedDocument(), attestPages: async pages => {
      return Promise.all(pages.map(async page => {
        const salt = crypto.getRandomValues(new Uint8Array(32));
        const commitment = await pageCommitment(page.metadata, page.content, salt);
        seen.push(commitment);
        const signature = await signAsync(attestationMessage(metadata, commitment), decodeBase64Url(privateKey));
        return { ...metadata, salt, signature: encodeBase64Url(signature), public_key: publicKey };
      }));
    } });
    expect(seen).toHaveLength(4);
    expect(seen.every(value => value.length === 32)).toBe(true);
    const results = await Promise.all(pageSealStrings.map(seals => verifyQRedSeals(seals, "", { [key_id]: publicKey })));
    expect(results.every(result => result.status === "VALID" && result.identity_authenticated)).toBe(true);
    expect(results[1].evidence.visual).toBeTruthy();
    expect(results[3].evidence.blank).toBe(true);
  });
  it.each([0, 90, 180, 270])("preserves visible image pixels through a footer with rotation %s and a crop", async rotation => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([500, 600]);
    page.drawRectangle({ x: 70, y: 110, width: 200, height: 190, color: rgb(0, 0, 0) });
    page.drawCircle({ x: 200, y: 350, size: 50, color: rgb(0.5, 0.5, 0.5) });
    page.setCropBox(20, 30, 450, 550); page.setRotation(degrees(rotation));
    const geometry = visiblePageGeometry(page), file = await asFile(pdf);
    const original = await withPdfDocument(file, source => renderPdfPage(source, 1, 1, { reference: true }));
    const { blob, sealResult } = await sealPdfInBrowser({ file, privateKey, publicKey, pageScalingStrategy: "legal-footer" });
    const stamped = await withPdfDocument(blob, source => renderPdfPage(source, 1, 1, { reference: true }));
    expect(stamped.width).toBe(geometry.width);
    expect(stamped.height).toBe(geometry.height + 216);
    expect(stamped.data.subarray(0, original.data.length)).toEqual(original.data);
    expect(sealResult.evidence.width).toBe(original.width);
    expect(sealResult.evidence.height).toBe(original.height);
  });
  it("does not call a faint marked page blank", async () => {
    const pdf = await PDFDocument.create(), page = pdf.addPage([612, 792]);
    page.drawRectangle({ x: 100, y: 100, width: 5, height: 5, color: rgb(0.99, 0.99, 0.99) });
    const { sealResult } = await sealPdfInBrowser({ file: await asFile(pdf), privateKey, publicKey });
    expect(sealResult.evidence.blank).toBe(false);
    expect(sealResult.evidence.visual).toBeTruthy();
  });
});
