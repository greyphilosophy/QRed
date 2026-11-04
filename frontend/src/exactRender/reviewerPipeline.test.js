import { beforeAll, describe, expect, it } from "vitest";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { PDFDocument, rgb } from "pdf-lib";
import { verifyExactPdf } from "./exactPdf.js";
import { EXACT_PROFILE, renderExactPage, withExactDocument } from "./renderer.js";
import { exactDocumentRoot, EXACT_STYLE, rasterHash } from "./evidence.js";
import { createExactRecord, authenticateExactRecord } from "./record.js";
import { chooseExactBoxes } from "./placement.js";
import { createQRedQrSymbol } from "../qredQr.js";
import { drawQrSymbol } from "../pdf/qrDrawing.js";
import { scanErasureSeals } from "../qr/scanErasureSeals.js";

const privateKey = "txzqca0BtMpjGTzQWh_FnBgQyiGjuf1mdhBMzCutAes=";
const publicKey = "eC4VZfi1rwwnKF-m5H0wg5kJ9OGeNhPddtr2yQI5i0Q=";

// Independently assemble intentionally nonconforming but cryptographically
// authentic synthetic PDFs. The verifier receives only the final Blob and key.
async function assemble({ wrongRoot = false, mixedTimestamps = false } = {}) {
  const source = await PDFDocument.create();
  for (let number = 1; number <= 2; number++) source.addPage([612, 792])
    .drawText(`Independent reviewer synthetic page ${number}: 605.29`, { x: 72, y: 730, size: 12 });
  const sourceFile = new Blob([await source.save()]);
  const plans = await withExactDocument(sourceFile, async pdf => {
    const values = [];
    for (let number = 1; number <= 2; number++) {
      const image = await renderExactPage(pdf, number);
      values.push({ width: image.width, height: image.height, sourceSha256: await rasterHash(image.data), boxes: await chooseExactBoxes(image) });
    }
    return values;
  });
  const root = wrongRoot ? "0".repeat(64) : await exactDocumentRoot(plans, EXACT_PROFILE);
  const output = await PDFDocument.load(await sourceFile.arrayBuffer());
  const manifests = [];
  for (let index = 0; index < plans.length; index++) {
    const plan = plans[index];
    const manifest = { type: "QRED-EXACT-RENDER", version: 1, profile: EXACT_PROFILE, style: EXACT_STYLE,
      width: plan.width, height: plan.height, scale: 2, rotation: 0, userUnit: 1, bounds: [0, 0, plan.width / 2, plan.height / 2],
      page: index + 1, pages: plans.length, sourceSha256: plan.sourceSha256, documentRoot: root,
      required: 12, total: 16, boxes: plan.boxes };
    manifests.push(manifest);
    const { seals } = await createExactRecord(manifest, { privateKey, publicKey, profile: EXACT_PROFILE,
      timestamp: mixedTimestamps && index ? "2026-11-04T07:00:01Z" : "2026-11-04T07:00:00Z" });
    seals.forEach((seal, i) => {
      const [x, y, width, height] = manifest.boxes[i];
      drawQrSymbol(output.getPage(index), createQRedQrSymbol(seal, { errorCorrectionLevel: "M" }),
        { x: x / 2, y: (manifest.height - y - height) / 2, width: width / 2, height: height / 2 }, .85, false);
    });
  }
  return { blob: new Blob([await output.save()]), manifests };
}

describe("independent optical collection and stamp adversaries (Node-only profile)", () => {
  let valid;
  beforeAll(async () => {
    globalThis.ImageData = ImageData;
    globalThis.document = { createElement: () => createCanvas(1, 1) };
    valid = await assemble();
  }, 30000);
  it("validates the independently assembled control without any source argument", async () => {
    const result = await verifyExactPdf({ file: valid.blob, publicKey });
    expect(result.completeExactRenderedDocument).toBe(true);
    expect(result.pages).toHaveLength(2);
    expect(result.pages.every(page => page.signatureStatus === "VALID" && page.exactRender.status === "exact-render-match")).toBe(true);
  }, 30000);
  it.each([
    ["fabricated common root", { wrongRoot: true }],
    ["mixed signing timestamps", { mixedTimestamps: true }],
  ])("rejects %s despite valid signatures and matching individual pixels", async (_label, options) => {
    const { blob } = await assemble(options);
    const result = await verifyExactPdf({ file: blob, publicKey });
    expect(result.completeExactRenderedDocument).toBe(false);
    expect(result.pages).toHaveLength(2);
    for (const page of result.pages) expect(page).toMatchObject({ signatureStatus: "VALID",
      exactRender: { status: "inconclusive", reason: "document-root-or-signing-session-mismatch" } });
  }, 30000);
  it("refuses a missing document page instead of presenting a complete single-page document", async () => {
    const truncated = await PDFDocument.load(await valid.blob.arrayBuffer()); truncated.removePage(1);
    const result = await verifyExactPdf({ file: new Blob([await truncated.save()]), publicKey });
    expect(result.completeExactRenderedDocument).toBe(false);
    expect(result.pages[0]).toMatchObject({ signatureStatus: "VALID", exactRender: { status: "inconclusive", reason: "page-position-or-count-mismatch" } });
  }, 30000);
  it("rejects one erased physical stamp even while fifteen surviving shards still authenticate", async () => {
    const changed = await PDFDocument.load(await valid.blob.arrayBuffer());
    const manifest = valid.manifests[0], [x, y, width, height] = manifest.boxes[0];
    changed.getPage(0).drawRectangle({ x: x / 2, y: (manifest.height - y - height) / 2,
      width: width / 2, height: height / 2, color: rgb(1, 1, 1) });
    const file = new Blob([await changed.save()]);
    const seals = await withExactDocument(file, async pdf => scanErasureSeals(await renderExactPage(pdf, 1)));
    expect(seals).toHaveLength(15);
    expect((await authenticateExactRecord(seals, publicKey, { profile: EXACT_PROFILE })).signatureStatus).toBe("VALID");
    const result = await verifyExactPdf({ file, publicKey });
    expect(result.completeExactRenderedDocument).toBe(false);
    expect(result.pages[0]).toMatchObject({ signatureStatus: "VALID", exactRender: { status: "inconclusive", reason: "seal-pixels-mismatch" } });
  }, 30000);
});
