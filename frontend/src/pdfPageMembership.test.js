import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { signAsync } from "@noble/ed25519";
import { attestationMessage, pageCommitment } from "./attestation.js";
import { sealPdfInBrowser } from "./pdfClientSeal.js";
import { renderPdfPage, withPdfDocument } from "./pdf/readPdfText.js";
import { computeKeyId } from "./qredSealer.js";
import { decodeSeal, verifyQRedSeals } from "./qredVerifier.js";
import { decodeBase64Url, encodeBase64Url, encodeEnvelope, sealString } from "./sealFormat.js";
import { qredPayloadFromScanResult } from "./qr/qrPayload.js";
import { scanQrImage } from "./qr/scanQrImage.js";
import { createVerificationSession } from "./verifier/verificationSession.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q";
const timestamp = "2026-11-04T12:00:00.000Z";
const identity = { provider: "google", name_source: "google", email: "issuer@example.com",
  name: "Synthetic test issuer", subject: "page-swap-test" };

const asFile = async pdf => new File([await pdf.save()], "document.pdf", { type: "application/pdf" });

async function makeDocument(texts) {
  const pdf = await PDFDocument.create();
  for (const text of texts) pdf.addPage([612, 792]).drawText(text, { x: 72, y: 720, size: 12 });
  return asFile(pdf);
}

// Copy the already stamped pages, including the real printed seals. Do not
// regenerate or sign either page after substituting the second sheet.
async function swappedPdf(first, second) {
  const pdf = await PDFDocument.create();
  for (const [blob, index] of [[first.blob, 0], [second.blob, 1]]) {
    const source = await PDFDocument.load(await blob.arrayBuffer());
    const [page] = await pdf.copyPages(source, [index]);
    pdf.addPage(page);
  }
  return asFile(pdf);
}

async function readPrintedSeals(file) {
  return withPdfDocument(file, async pdf => {
    expect(pdf.numPages).toBe(2);
    const seals = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const image = await renderPdfPage(pdf, number);
      // Scan the whole rendered page, not seal strings saved by the stamper.
      const payload = qredPayloadFromScanResult(scanQrImage(image.data, image.width, image.height));
      expect(decodeSeal(payload)).toMatchObject({ total_chunks: 1 });
      seals.push(payload);
    }
    return seals;
  });
}

async function checkCollection(seals, verify) {
  // This is the shared collection used by both the homepage and standalone UI.
  const session = createVerificationSession();
  session.add(seals);
  await session.verify(publicKey, verify);
  return session.getSnapshot();
}

afterEach(() => vi.useRealTimers());

describe.each(["private key", "account attestation"])("cross-document page substitution: %s", method => {
  it.each([
    { name: "a current cover with older results", a: ["Cover letter: November 2026", "November results: approved"], b: ["Cover letter: October 2026", "October results: pending"] },
    { name: "identical cover text", samePage: 1, a: ["Shared cover letter", "Approved total: 100.00"], b: ["Shared cover letter", "Approved total: 900.00"] },
    { name: "identical second-page text", samePage: 2, a: ["Agreement A", "Shared second page"], b: ["Agreement B", "Shared second page"] },
  ])("does not complete a mixed PDF with $name", async ({ samePage, a, b }) => {
    // Eliminate time, signer, filename, dimensions, page count, and account
    // identity as accidental reasons for separating the two documents.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(timestamp));
    const keyId = await computeKeyId(publicKey);
    const verify = seals => verifyQRedSeals(seals, publicKey, { [keyId]: publicKey });
    const attestPages = async pages => Promise.all(pages.map(async page => {
      const metadata = { key_id: keyId, timestamp, identity };
      const signature = await signAsync(attestationMessage(metadata,
        await pageCommitment(page.metadata, page.content)), decodeBase64Url(privateKey));
      return { ...metadata, public_key: publicKey, signature: encodeBase64Url(signature) };
    }));
    const documents = [];
    for (const texts of [a, b]) {
      documents.push(await sealPdfInBrowser({ file: await makeDocument(texts),
        ...(method === "private key" ? { privateKey, publicKey } : { attestPages }),
        pageScalingStrategy: "legal-footer" }));
    }
    const originals = [];
    for (const document of documents) {
      expect(document.pageSealStrings.map(seals => seals.length)).toEqual([1, 1]);
      const original = await checkCollection(document.pageSealStrings.flat(), verify);
      expect(original.progress).toMatchObject({ pagesCollected: 2, pagesTotal: 2, complete: true, finished: true });
      for (const page of original.results) {
        expect(page).toMatchObject({ status: "VALID", signature_valid: true, metadata_authenticated: true,
          timestamp, key_id: keyId, page_count: 2 });
        if (method === "account attestation") expect(page).toMatchObject({ identity, identity_authenticated: true });
      }
      expect(original.results[0].document_root).toBe(original.results[1].document_root);
      originals.push(original.results);
    }
    expect(originals[0][0].document_root).not.toBe(originals[1][0].document_root);
    if (samePage) {
      expect(originals[0][samePage - 1].content).toBe(originals[1][samePage - 1].content);
      expect(originals[0][samePage - 1].page_hash).toBe(originals[1][samePage - 1].page_hash);
      expect(originals[0][samePage - 1].document_id).not.toBe(originals[1][samePage - 1].document_id);
    }

    // Swap in both directions, then scan each mixed PDF in both page orders.
    for (const [first, second] of [documents, [...documents].reverse()]) {
      const printed = await readPrintedSeals(await swappedPdf(first, second));
      expect(printed).toEqual([first.pageSealStrings[0][0], second.pageSealStrings[1][0]]);
      for (const scanned of [printed, [...printed].reverse()]) {
        const mixed = await checkCollection(scanned, verify);
        expect(mixed.results).toHaveLength(2);
        // Neither signature was forged. The failure is document membership,
        // not page authenticity, so individually VALID pages are expected.
        expect(mixed.results.every(page => page.status === "VALID" && page.metadata_authenticated)).toBe(true);
        expect(new Set(mixed.results.map(page => page.document_root)).size).toBe(2);
        expect(mixed.progress).toMatchObject({ pagesCollected: 1, pagesTotal: 2, complete: false, finished: false, mixedDocuments: true });
        expect(mixed.progress.documentWarning).toContain("different documents or signing versions");
        expect(mixed.progress.message).toContain("1 of 2 pages collected");
        expect(mixed.progress.message).not.toContain("All 2 pages collected");
      }
    }

    // An attacker cannot repair the mismatch by copying the desired document
    // root into the foreign page while retaining its genuine signature/body.
    const foreign = decodeSeal(documents[1].pageSealStrings[1][0]);
    const forged = sealString(encodeEnvelope({ ...foreign, document_root: originals[0][0].document_root },
      foreign.signature, foreign.data, foreign.encoding));
    expect(await verify([forged])).toMatchObject({ status: "INVALID", signature_valid: false,
      metadata_authenticated: false, error_message: "Digital signature verification failed" });
    const forgedCollection = await checkCollection([documents[0].pageSealStrings[0][0], forged], verify);
    expect(forgedCollection.progress).toMatchObject({ complete: false, finished: true });
    expect(forgedCollection.progress.message).toContain("Seal verification failed");
  }, 30000);
});
